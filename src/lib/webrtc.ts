import type { PeerOptions } from 'peerjs';
import type { TranslationKey } from '@/i18n';

/**
 * Public STUN servers for NAT/LAN traversal so 100% of video & audio streams
 * directly peer-to-peer over local Wi-Fi without cloud video relay costs.
 * Note: Intentionally omits `iceCandidatePoolSize` to prevent iOS Safari WebKit
 * from pre-gathering stale mDNS-only candidates before media tracks settle.
 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.services.mozilla.com' },
  ],
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

export const PEER_OPTIONS: PeerOptions = {
  debug: 1,
  config: RTC_CONFIG,
};

export type ConnectionStatus = 'waiting' | 'connecting' | 'live' | 'disconnected' | 'ready';

export type VideoQuality = '720p' | '1080p';
export type CameraFacing = 'user' | 'environment';

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

    // Locate end of video media section
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
      const codec = codecByPt.get(pt);
      if (codec === 'VP8') {
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
 * Fixes a critical PeerJS 1.5.x race condition that frequently breaks Apple iOS Safari:
 * PeerJS invokes async `handleSDP()` (setRemoteDescription) without awaiting it, and then
 * immediately calls `handleCandidate()` for queued ICE candidates. On iOS Safari WebKit
 * (which bursts candidates right behind the SDP Offer/Answer), `addIceCandidate` throws
 * `InvalidStateError` before `remoteDescription` is set and PeerJS discards the candidates,
 * leaving ICE stuck in `checking` with a black screen.
 *
 * This wrapper buffers incoming ICE candidates until `remoteDescription` is set, then
 * flushes all queued candidates cleanly in order.
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
 * Attaches a MediaStream to an HTMLVideoElement with full Safari/iOS/Chrome safety:
 * sets `playsinline` + `webkit-playsinline`, assigns `srcObject`, and retries `.play()`
 * on metadata/canplay events so black frames never stall playback.
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

/**
 * Extracts estimated round-trip latency (ms) from RTCPeerConnection.getStats().
 */
export async function measurePeerLatencyMs(
  pc: RTCPeerConnection | null | undefined
): Promise<number | null> {
  if (!pc || typeof pc.getStats !== 'function') return null;
  try {
    const stats = await pc.getStats();
    let bestRttSeconds: number | null = null;

    stats.forEach((report) => {
      if (
        report.type === 'candidate-pair' &&
        (report.nominated || report.state === 'succeeded') &&
        typeof report.currentRoundTripTime === 'number' &&
        report.currentRoundTripTime >= 0
      ) {
        bestRttSeconds = report.currentRoundTripTime;
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

    if (bestRttSeconds !== null) {
      return Math.max(1, Math.round(bestRttSeconds * 1000));
    }
    return null;
  } catch {
    return null;
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
