export const PRODUCTION_ORIGIN = 'https://phonewebcam.pages.dev';

/**
 * Collision-safe 32-character uppercase alphabet excluding ambiguous characters:
 * O, 0, I, 1 are excluded so codes are effortless to read and type across screens.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

const ROOM_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

function randomChars(length: number): string {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return result;
}

/**
 * Generates a collision-safe 4-character alphanumeric room code (e.g. A7K9).
 */
export function generateRoomCode(excludeCode?: string): string {
  let code = randomChars(ROOM_CODE_LENGTH);
  let attempts = 0;
  while (excludeCode && code === excludeCode && attempts < 10) {
    code = randomChars(ROOM_CODE_LENGTH);
    attempts++;
  }
  return code;
}

/**
 * Sanitizes user input for room codes: uppercase, strips invalid characters, max 4 chars.
 */
export function sanitizeRoomCode(raw: string): string {
  const upper = raw.toUpperCase();
  let cleaned = '';
  for (const ch of upper) {
    if (ROOM_CODE_ALPHABET.includes(ch)) {
      cleaned += ch;
      if (cleaned.length >= ROOM_CODE_LENGTH) break;
    }
  }
  return cleaned;
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_REGEX.test(code.trim().toUpperCase());
}

/**
 * Namespaced PeerJS IDs prevent collisions with unrelated apps on the public PeerServer.
 */
export function getReceiverPeerId(code: string): string {
  return `pwc-v1-recv-${code.toUpperCase()}`;
}

export function getSenderPeerId(code: string): string {
  return `pwc-v1-send-${code.toUpperCase()}-${randomChars(6).toLowerCase()}`;
}

export function getObsRelayPeerId(code: string): string {
  return `pwc-v1-obs-${code.toUpperCase()}-${randomChars(6).toLowerCase()}`;
}

/**
 * Returns the canonical Phone pairing URL encoded inside the Desktop QR code.
 */
export function getPhonePairUrl(code: string): string {
  return `${PRODUCTION_ORIGIN}/?mode=phone&code=${encodeURIComponent(code.toUpperCase())}`;
}

export type VideoRotation = 0 | 90 | 180 | 270;
export type VideoOrientation = 'horizontal' | 'vertical';

export interface ObsViewOptions {
  rotation?: VideoRotation;
  mirror?: boolean;
  orientation?: VideoOrientation;
}

export function parseVideoRotation(raw: string | null | undefined): VideoRotation {
  const num = Number(raw);
  if (num === 90 || num === 180 || num === 270) return num;
  return 0;
}

/**
 * Returns the Clean OBS Browser Source URL, preserving optional rotation/mirror/orientation.
 */
export function getObsCleanViewUrl(code: string, options?: ObsViewOptions): string {
  const params = new URLSearchParams();
  params.set('view', code.toUpperCase());
  if (options?.rotation) {
    params.set('rot', String(options.rotation));
  }
  if (options?.mirror) {
    params.set('mirror', '1');
  }
  if (options?.orientation === 'vertical') {
    params.set('orient', 'vertical');
  }
  return `${PRODUCTION_ORIGIN}/?${params.toString()}`;
}

/**
 * Detects whether the current device is likely a mobile phone / tablet camera sender.
 */
export function detectMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const mobileRegex =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|CriOS|FxiOS/i;
  if (mobileRegex.test(ua)) return true;

  // Detect iPadOS masquerading as macOS desktop Safari
  if (
    typeof document !== 'undefined' &&
    /Macintosh/i.test(ua) &&
    navigator.maxTouchPoints > 1
  ) {
    return true;
  }

  return false;
}
