import type { PeerOptions } from 'peerjs';
import type { TranslationKey } from '@/i18n';

/**
 * Public STUN servers for NAT/LAN traversal so 100% of video & audio streams
 * directly peer-to-peer over local Wi-Fi without cloud video relay costs.
 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceCandidatePoolSize: 4,
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
      frameRate: { ideal: 30, max: 60 },
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
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
      // Round-trip time to one-way/display latency in ms (minimum 1ms when live on LAN)
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
