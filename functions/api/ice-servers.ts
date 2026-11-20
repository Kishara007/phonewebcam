/**
 * Cloudflare Pages Function: GET /api/ice-servers
 *
 * Strict Zero-Secret 3-Tier Smart TURN Fallback Chain (Metered -> Turnix -> ExpressTURN):
 *
 * - Default (`GET /api/ice-servers`):
 *     Returns fast STUN-only servers (`hasTurn: false`, `provider: "stun-only"`) so same-Wi-Fi
 *     P2P sessions use 0 bytes of TURN relay quota.
 *
 * - Relay mode (`GET /api/ice-servers?mode=relay`, optional `&skip=metered,turnix`):
 *     Selects ONLY ONE active TURN provider at a time (keeping iOS Safari ICE probing fast)
 *     in strict priority order, reading all secrets exclusively from Cloudflare `env`:
 *       1. Metered (`METERED_APP_NAME` + `METERED_API_KEY`, or `METERED_USERNAME` + `METERED_PASSWORD`)
 *       2. Turnix (`TURNIX_API_TOKEN`, or `TURNIX_USERNAME` + `TURNIX_PASSWORD` + optional `TURNIX_URL`)
 *       3. ExpressTURN (`EXPRESSTURN_USERNAME` + `EXPRESSTURN_PASSWORD`)
 *
 * - If no TURN env vars are configured or all providers are skipped/unavailable:
 *     Safely returns STUN-only (`hasTurn: false`, `provider: "stun-only"`).
 */

export type TurnProvider = 'stun-only' | 'metered' | 'turnix' | 'expressturn';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceServersResponse {
  hasTurn: boolean;
  provider: TurnProvider;
  iceServers: IceServerConfig[];
}

export interface Env {
  // Priority 1: Metered (dynamic API recommended; static credentials also supported)
  METERED_APP_NAME?: string;
  METERED_API_KEY?: string;
  METERED_USERNAME?: string;
  METERED_PASSWORD?: string;

  // Priority 2: Turnix (dynamic API token or static credentials)
  TURNIX_API_TOKEN?: string;
  TURNIX_USERNAME?: string;
  TURNIX_PASSWORD?: string;
  TURNIX_URL?: string;

  // Priority 3: ExpressTURN
  EXPRESSTURN_USERNAME?: string;
  EXPRESSTURN_PASSWORD?: string;
}

const DEFAULT_STUN_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const UPSTREAM_TIMEOUT_MS = 2000;

function jsonResponse(body: IceServersResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isTurnEntry(entry: unknown): entry is IceServerConfig {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as { urls?: unknown };
  const rawUrls = Array.isArray(candidate.urls)
    ? candidate.urls
    : typeof candidate.urls === 'string'
      ? [candidate.urls]
      : [];
  return rawUrls.some((u) => {
    const lower = String(u || '').trim().toLowerCase();
    return lower.startsWith('turn:') || lower.startsWith('turns:');
  });
}

function filterTurnEntries(entries: unknown): IceServerConfig[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(isTurnEntry);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = UPSTREAM_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveMeteredTurn(env: Env): Promise<IceServerConfig[] | null> {
  const appName = env.METERED_APP_NAME?.trim();
  const apiKey = env.METERED_API_KEY?.trim();

  if (appName && apiKey) {
    try {
      const meteredUrl = `https://${encodeURIComponent(appName)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
      const res = await fetchWithTimeout(meteredUrl, { method: 'GET' });
      if (!res.ok) return null;
      const payload = (await res.json()) as unknown;
      const turnEntries = filterTurnEntries(payload);
      return turnEntries.length > 0 ? turnEntries : null;
    } catch {
      // Timeout, network error, or quota error -> fall through cleanly to Priority 2
      return null;
    }
  }

  const username = env.METERED_USERNAME?.trim();
  const password = env.METERED_PASSWORD?.trim();
  if (username && password) {
    return [
      {
        urls: [
          'turn:global.relay.metered.ca:80',
          'turn:global.relay.metered.ca:80?transport=tcp',
          'turn:global.relay.metered.ca:443',
          'turns:global.relay.metered.ca:443?transport=tcp',
        ],
        username,
        credential: password,
      },
    ];
  }

  return null;
}

async function resolveTurnixTurn(env: Env): Promise<IceServerConfig[] | null> {
  const apiToken = env.TURNIX_API_TOKEN?.trim();

  if (apiToken) {
    try {
      const res = await fetchWithTimeout('https://turnix.io/api/v1/credentials/ice', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 3600 }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        iceServers?: unknown;
        ice_servers?: unknown;
      };
      const rawList = Array.isArray(data)
        ? data
        : Array.isArray(data?.iceServers)
          ? data.iceServers
          : Array.isArray(data?.ice_servers)
            ? data.ice_servers
            : [];
      const turnEntries = filterTurnEntries(rawList);
      return turnEntries.length > 0 ? turnEntries : null;
    } catch {
      // Timeout, network error, or quota error -> fall through cleanly to Priority 3
      return null;
    }
  }

  const username = env.TURNIX_USERNAME?.trim();
  const password = env.TURNIX_PASSWORD?.trim();
  if (username && password) {
    const rawUrl = env.TURNIX_URL?.trim() || 'turn:turn.turnix.io:3478';
    const parsedUrls = rawUrl
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    const urls = parsedUrls.length === 1 ? parsedUrls[0] : parsedUrls;
    return [
      {
        urls,
        username,
        credential: password,
      },
    ];
  }

  return null;
}

function resolveExpressTurn(env: Env): IceServerConfig[] | null {
  const username = env.EXPRESSTURN_USERNAME?.trim();
  const password = env.EXPRESSTURN_PASSWORD?.trim();
  if (!username || !password) return null;

  return [
    {
      urls: [
        'turn:free.expressturn.com:3478?transport=udp',
        'turn:free.expressturn.com:3478?transport=tcp',
        'turns:free.expressturn.com:443?transport=tcp',
      ],
      username,
      credential: password,
    },
  ];
}

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const wantRelay = url.searchParams.get('mode') === 'relay';

  if (!wantRelay) {
    return jsonResponse({
      hasTurn: false,
      provider: 'stun-only',
      iceServers: [...DEFAULT_STUN_SERVERS],
    });
  }

  const skipped = new Set(
    (url.searchParams.get('skip') || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  // Priority 1 — Metered
  if (!skipped.has('metered')) {
    const meteredTurn = await resolveMeteredTurn(env);
    if (meteredTurn && meteredTurn.length > 0) {
      return jsonResponse({
        hasTurn: true,
        provider: 'metered',
        iceServers: [...DEFAULT_STUN_SERVERS, ...meteredTurn],
      });
    }
  }

  // Priority 2 — Turnix
  if (!skipped.has('turnix')) {
    const turnixTurn = await resolveTurnixTurn(env);
    if (turnixTurn && turnixTurn.length > 0) {
      return jsonResponse({
        hasTurn: true,
        provider: 'turnix',
        iceServers: [...DEFAULT_STUN_SERVERS, ...turnixTurn],
      });
    }
  }

  // Priority 3 — ExpressTURN
  if (!skipped.has('expressturn')) {
    const expressTurn = resolveExpressTurn(env);
    if (expressTurn && expressTurn.length > 0) {
      return jsonResponse({
        hasTurn: true,
        provider: 'expressturn',
        iceServers: [...DEFAULT_STUN_SERVERS, ...expressTurn],
      });
    }
  }

  // Safe STUN-only fallback when no TURN env vars are configured or all providers were skipped/exhausted
  return jsonResponse({
    hasTurn: false,
    provider: 'stun-only',
    iceServers: [...DEFAULT_STUN_SERVERS],
  });
}
