import type { PeerOptions } from 'peerjs';
import type { TranslationKey } from '@/i18n';

/**
 * Stage 1 (Default): STUN-only ICE servers for direct local Wi-Fi / P2P streaming.
 * Uses 0 bytes of TURN relay quota when devices can connect directly over LAN.
 * Intentionally omits `iceCandidatePoolSize` and `max-bundle` for iOS Safari WebKit compatibility.
 */
export const STUN_ONLY_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: STUN_ONLY_SERVERS,
};

export const PEER_OPTIONS: PeerOptions = {
  debug: 1,
  config: RTC_CONFIG,
};

export type TurnProvider = 'stun-only' | 'metered' | 'turnix' | 'expressturn';
export type ActiveTurnProvider = Exclude<TurnProvider, 'stun-only'>;

export interface RelayFallbackResult {
  peerOptions: PeerOptions;
  provider: ActiveTurnProvider;
}

const VALID_ACTIVE_PROVIDERS = new Set<ActiveTurnProvider>([
  'metered',
  'turnix',
  'expressturn',
]);

// STUN/TURN RFC 5766/8656 error codes indicating quota exhaustion or rejected credentials
const TURN_QUOTA_OR_AUTH_ERROR_CODES = new Set([401, 403, 437, 486, 508]);
const TURN_COOLDOWN_MS = 15 * 60 * 1000;
const RELAY_CACHE_TTL_MS = 10 * 60 * 1000;

let turnUnavailableUntil = 0;
const skippedProviders = new Set<ActiveTurnProvider>();
let cachedRelayResult: {
  config: RTCConfiguration;
  provider: ActiveTurnProvider;
  expiresAt: number;
} | null = null;

export function isTurnQuotaUnavailable(): boolean {
  if (turnUnavailableUntil > 0 && Date.now() >= turnUnavailableUntil) {
    // Cooldown expired — reset session skip list so providers can be probed cleanly again
    turnUnavailableUntil = 0;
    skippedProviders.clear();
    cachedRelayResult = null;
    return false;
  }
  return Date.now() < turnUnavailableUntil;
}

export function markTurnQuotaUnavailable(): void {
  turnUnavailableUntil = Date.now() + TURN_COOLDOWN_MS;
  cachedRelayResult = null;
}

export function getSkippedTurnProviders(): ActiveTurnProvider[] {
  return Array.from(skippedProviders);
}

/**
 * Adds a failing/quota-exhausted TURN provider to the session skip list so the next
 * `/api/ice-servers?mode=relay&skip=...` call seamlessly hops to the next provider
 * in the Metered -> Turnix -> ExpressTURN chain before entering TURN cooldown.
 */
export function skipTurnProvider(provider: ActiveTurnProvider): void {
  if (!VALID_ACTIVE_PROVIDERS.has(provider)) return;
  skippedProviders.add(provider);
  if (cachedRelayResult?.provider === provider) {
    cachedRelayResult = null;
  }
}

export function resetTurnProviderState(): void {
  turnUnavailableUntil = 0;
  skippedProviders.clear();
  cachedRelayResult = null;
}

/**
 * Listens safely for TURN quota / authentication rejections on an RTCPeerConnection.
 * When a `provider` is specified, marks that specific provider skipped so the caller can
 * hop seamlessly to the next provider in the 3-tier fallback chain.
 */
export function monitorTurnQuotaErrors(
  pc: RTCPeerConnection | null | undefined,
  provider?: ActiveTurnProvider,
  onQuotaRejected?: (rejectedProvider?: ActiveTurnProvider) => void
): () => void {
  if (!pc || typeof pc.addEventListener !== 'function') {
    return () => {};
  }

  let triggered = false;
  const handler = (event: Event) => {
    if (triggered) return;
    const iceErr = event as RTCPeerConnectionIceErrorEvent;
    const url = (iceErr.url || '').toLowerCase();
    const code = Number(iceErr.errorCode || 0);
    if (url.startsWith('turn') && TURN_QUOTA_OR_AUTH_ERROR_CODES.has(code)) {
      triggered = true;
      if (provider) {
        skipTurnProvider(provider);
      } else {
        markTurnQuotaUnavailable();
      }
      onQuotaRejected?.(provider);
    }
  };

  pc.addEventListener('icecandidateerror', handler);
  return () => pc.removeEventListener('icecandidateerror', handler);
}

/**
 * Fetches Stage 2 Relay-Assisted PeerJS options strictly from our Cloudflare Edge Function
 * (`/api/ice-servers?mode=relay`, appending `&skip=...` for any providers that already failed
 * or hit quota in this session).
 *
 * Contains ZERO hardcoded credentials. Returns `null` cleanly if no TURN env vars are configured
 * or all providers in the Metered -> Turnix -> ExpressTURN chain are currently exhausted.
 */
export async function getRelayFallbackPeerOptions(options?: {
  extraSkip?: ActiveTurnProvider[];
}): Promise<RelayFallbackResult | null> {
  if (typeof window === 'undefined') return null;
  if (isTurnQuotaUnavailable()) return null;

  if (options?.extraSkip && options.extraSkip.length > 0) {
    for (const p of options.extraSkip) {
      if (VALID_ACTIVE_PROVIDERS.has(p)) {
        skippedProviders.add(p);
      }
    }
    if (cachedRelayResult && skippedProviders.has(cachedRelayResult.provider)) {
      cachedRelayResult = null;
    }
  }

  const now = Date.now();
  if (
    cachedRelayResult &&
    now < cachedRelayResult.expiresAt &&
    !skippedProviders.has(cachedRelayResult.provider)
  ) {
    return {
      peerOptions: { debug: 1, config: cachedRelayResult.config },
      provider: cachedRelayResult.provider,
    };
  }

  const skipList = Array.from(skippedProviders);
  const endpoint =
    skipList.length > 0
      ? `/api/ice-servers?mode=relay&skip=${encodeURIComponent(skipList.join(','))}`
      : '/api/ice-servers?mode=relay';

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2500);
    const res = await fetch(endpoint, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    window.clearTimeout(timer);

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      iceServers?: RTCIceServer[];
      hasTurn?: boolean;
      provider?: TurnProvider;
    };

    if (
      data.hasTurn === true &&
      data.provider &&
      data.provider !== 'stun-only' &&
      VALID_ACTIVE_PROVIDERS.has(data.provider) &&
      Array.isArray(data.iceServers) &&
      data.iceServers.length > 0
    ) {
      const config: RTCConfiguration = { iceServers: data.iceServers };
      cachedRelayResult = {
        config,
        provider: data.provider,
        expiresAt: now + RELAY_CACHE_TTL_MS,
      };
      return {
        peerOptions: { debug: 1, config },
        provider: data.provider,
      };
    }

    // All configured TURN providers exhausted/skipped (or none configured) -> enter 15-min cooldown
    markTurnQuotaUnavailable();
    return null;
  } catch {
    // Offline or local `astro dev` without Pages Functions — degrade cleanly without crashing
    return null;
  }
}

export type ConnectionStatus = 'waiting' | 'connecting' | 'live' | 'disconnected' | 'ready';

export type VideoQuality = '720p' | '1080p';
export type CameraFacing = 'user' | 'environment';

export interface CallMetadata {
  relayFallback?: boolean;
  relayProvider?: ActiveTurnProvider;
  skippedProviders?: ActiveTurnProvider[];
}

export type PeerControlMessage =
  | { type: 'mic-state'; muted: boolean }
  | { type: 'camera-state'; facingMode: CameraFacing; resolution: VideoQuality }
  | { type: 'request-relay' }
  | { type: 'disconnect' }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number };

export function buildMediaConstraints(
  facingMode: CameraFacing,
  quality: VideoQuality
): MediaStreamConstraints {
  const is1080 = quality === '1080p';
  return {
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: is1080 ? 1920 : 1280 },
      height: { ideal: is1080 ? 1080 : 720 },
      frameRate: { ideal: 30 },
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

/**
 * Acquires camera & microphone safely on iOS Safari and Android Chrome,
 * falling back to relaxed constraints if a specific resolution is rejected.
 */
export async function acquireCameraStream(
  facingMode: CameraFacing,
  quality: VideoQuality
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(
      buildMediaConstraints(facingMode, quality)
    );
  } catch (err) {
    const name =
      err && typeof err === 'object' && 'name' in err
        ? String((err as { name: unknown }).name)
        : '';
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }
    throw err;
  }
}

/**
 * Reorders video payload types in the SDP `m=video` line to prioritize:
 *   1. VP8 (and its associated RTX) — universally decoded without H.264 profile mismatches
 *      between Apple iOS Safari WebKit and Windows Chrome/Edge/OBS CEF.
 *   2. H.264 Constrained Baseline (`42e01f` / `42001f`, `packetization-mode=1`) + RTX.
 *   3. All remaining negotiated codecs preserved intact as fallback.
 */
export function preferSafeVideoCodecs(sdp: string): string {
  try {
    const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(/\r?\n/);

    const videoLineIdx = lines.findIndex((line) => line.startsWith('m=video '));
    if (videoLineIdx === -1) return sdp;

    let videoEndIdx = lines.length;
    for (let i = videoLineIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('m=')) {
        videoEndIdx = i;
        break;
      }
    }

    const mParts = lines[videoLineIdx].split(' ');
    if (mParts.length <= 4) return sdp;
    const header = mParts.slice(0, 3);
    const payloadTypes = mParts.slice(3);

    const codecByPt = new Map<string, string>();
    const fmtpByPt = new Map<string, string>();
    const rtxForPt = new Map<string, string[]>();

    for (let i = videoLineIdx + 1; i < videoEndIdx; i++) {
      const line = lines[i];
      const rtpmap = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)/i);
      if (rtpmap) {
        codecByPt.set(rtpmap[1], rtpmap[2].toUpperCase());
        continue;
      }
      const fmtp = line.match(/^a=fmtp:(\d+)\s+(.+)$/i);
      if (fmtp) {
        fmtpByPt.set(fmtp[1], fmtp[2].toLowerCase());
        const apt = fmtp[2].match(/apt=(\d+)/i);
        if (apt) {
          const list = rtxForPt.get(apt[1]) ?? [];
          list.push(fmtp[1]);
          rtxForPt.set(apt[1], list);
        }
      }
    }

    const tier1Vp8: string[] = [];
    const tier2H264Baseline: string[] = [];
    const tier3Other: string[] = [];
    const added = new Set<string>();

    const pushWithRtx = (pt: string, bucket: string[]) => {
      if (added.has(pt)) return;
      bucket.push(pt);
      added.add(pt);
      const rtxList = rtxForPt.get(pt) ?? [];
      for (const rtxPt of rtxList) {
        if (!added.has(rtxPt) && payloadTypes.includes(rtxPt)) {
          bucket.push(rtxPt);
          added.add(rtxPt);
        }
      }
    };

    for (const pt of payloadTypes) {
      if (codecByPt.get(pt) === 'VP8') {
        pushWithRtx(pt, tier1Vp8);
      }
    }

    for (const pt of payloadTypes) {
      const codec = codecByPt.get(pt);
      const fmtp = fmtpByPt.get(pt) ?? '';
      if (
        codec === 'H264' &&
        (fmtp.includes('42e01f') || fmtp.includes('42001f')) &&
        fmtp.includes('packetization-mode=1')
      ) {
        pushWithRtx(pt, tier2H264Baseline);
      }
    }

    for (const pt of payloadTypes) {
      if (!added.has(pt)) {
        tier3Other.push(pt);
        added.add(pt);
      }
    }

    const reordered = [...tier1Vp8, ...tier2H264Baseline, ...tier3Other];
    if (reordered.length !== payloadTypes.length) return sdp;

    lines[videoLineIdx] = [...header, ...reordered].join(' ');
    return lines.join(lineEnding);
  } catch {
    return sdp;
  }
}

interface PeerJsNegotiatorLike {
  connection?: {
    peerConnection?: RTCPeerConnection | null;
  };
  handleSDP?: (type: string, sdp: RTCSessionDescriptionInit) => Promise<void>;
  handleCandidate?: (ice: RTCIceCandidateInit) => Promise<void>;
  __pwcIcePatched?: boolean;
}

interface PeerJsConnectionLike {
  _negotiator?: PeerJsNegotiatorLike | null;
}

/**
 * Fixes a PeerJS 1.5.x race condition that frequently breaks Apple iOS Safari:
 * buffers incoming ICE candidates until `setRemoteDescription` resolves, then flushes
 * them cleanly in arrival order so zero host/STUN/TURN candidates are discarded.
 */
export function patchPeerJsIceQueue(connection: unknown): void {
  const conn = connection as PeerJsConnectionLike | null | undefined;
  const negotiator = conn?._negotiator;
  if (!negotiator || negotiator.__pwcIcePatched) return;
  if (typeof negotiator.handleSDP !== 'function' || typeof negotiator.handleCandidate !== 'function') {
    return;
  }

  negotiator.__pwcIcePatched = true;
  const originalHandleSDP = negotiator.handleSDP.bind(negotiator);
  const originalHandleCandidate = negotiator.handleCandidate.bind(negotiator);

  const pendingCandidates: RTCIceCandidateInit[] = [];
  let remoteDescriptionReady = false;

  const flushCandidates = async () => {
    const pc = negotiator.connection?.peerConnection;
    if (!pc || !pc.remoteDescription) return;
    while (pendingCandidates.length > 0) {
      const next = pendingCandidates.shift();
      if (!next) continue;
      try {
        await originalHandleCandidate(next);
      } catch {
        // Ignore stale candidates after close
      }
    }
  };

  negotiator.handleCandidate = async (ice: RTCIceCandidateInit) => {
    const pc = negotiator.connection?.peerConnection;
    if (!remoteDescriptionReady || !pc || !pc.remoteDescription) {
      pendingCandidates.push(ice);
      return;
    }
    await originalHandleCandidate(ice);
  };

  negotiator.handleSDP = async (type: string, sdp: RTCSessionDescriptionInit) => {
    await originalHandleSDP(type, sdp);
    const pc = negotiator.connection?.peerConnection;
    if (pc && pc.remoteDescription) {
      remoteDescriptionReady = true;
      await flushCandidates();
    }
  };
}

/**
 * Attaches a MediaStream to an HTMLVideoElement with full Safari/iOS/Chrome safety.
 */
export function attachStreamToVideo(
  videoEl: HTMLVideoElement,
  stream: MediaStream,
  muted: boolean
): () => void {
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('webkit-playsinline', '');
  videoEl.playsInline = true;
  videoEl.autoplay = true;
  videoEl.muted = muted;

  if (videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
  }

  const safePlay = () => {
    videoEl.play().catch(() => {});
  };

  safePlay();
  videoEl.addEventListener('loadedmetadata', safePlay);
  videoEl.addEventListener('canplay', safePlay);

  const tracks = stream.getVideoTracks();
  tracks.forEach((track) => {
    track.addEventListener('unmute', safePlay);
  });

  return () => {
    videoEl.removeEventListener('loadedmetadata', safePlay);
    videoEl.removeEventListener('canplay', safePlay);
    tracks.forEach((track) => {
      track.removeEventListener('unmute', safePlay);
    });
  };
}

export interface PeerTelemetry {
  latencyMs: number | null;
  isRelayed: boolean;
}

/**
 * Extracts estimated round-trip latency (ms) and whether media is flowing via direct P2P
 * or TURN relay from RTCPeerConnection.getStats().
 */
export async function measurePeerTelemetry(
  pc: RTCPeerConnection | null | undefined
): Promise<PeerTelemetry> {
  if (!pc || typeof pc.getStats !== 'function') {
    return { latencyMs: null, isRelayed: false };
  }
  try {
    const stats = await pc.getStats();
    let bestRttSeconds: number | null = null;
    let activeLocalId: string | null = null;
    let activeRemoteId: string | null = null;

    stats.forEach((report) => {
      if (
        report.type === 'candidate-pair' &&
        (report.nominated || report.state === 'succeeded')
      ) {
        if (
          typeof report.currentRoundTripTime === 'number' &&
          report.currentRoundTripTime >= 0
        ) {
          bestRttSeconds = report.currentRoundTripTime;
        }
        if (report.localCandidateId) activeLocalId = String(report.localCandidateId);
        if (report.remoteCandidateId) activeRemoteId = String(report.remoteCandidateId);
      }
    });

    let isRelayed = false;
    stats.forEach((report) => {
      if (
        (report.id === activeLocalId || report.id === activeRemoteId) &&
        report.candidateType === 'relay'
      ) {
        isRelayed = true;
      }
    });

    if (bestRttSeconds === null) {
      stats.forEach((report) => {
        if (
          report.type === 'remote-inbound-rtp' &&
          typeof report.roundTripTime === 'number' &&
          report.roundTripTime >= 0
        ) {
          bestRttSeconds = report.roundTripTime;
        }
      });
    }

    return {
      latencyMs: bestRttSeconds !== null ? Math.max(1, Math.round(bestRttSeconds * 1000)) : null,
      isRelayed,
    };
  } catch {
    return { latencyMs: null, isRelayed: false };
  }
}

export function mapMediaErrorToKey(err: unknown): TranslationKey {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'error.insecureContext';
  }
  if (!navigator?.mediaDevices?.getUserMedia) {
    return 'error.insecureContext';
  }

  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'error.permissionDenied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'error.noDevice';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'error.deviceInUse';
    default:
      return 'error.generic';
  }
}

export function mapPeerErrorToKey(err: unknown): TranslationKey {
  const type =
    err && typeof err === 'object' && 'type' in err
      ? String((err as { type: unknown }).type)
      : '';

  switch (type) {
    case 'peer-unavailable':
      return 'error.peerUnavailable';
    case 'network':
    case 'webrtc':
    case 'disconnected':
      return 'error.networkDrop';
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'error.signalingFailed';
    case 'invalid-id':
      return 'error.invalidCode';
    default:
      return 'error.generic';
  }
}
