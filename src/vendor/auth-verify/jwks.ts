import type { JsonWebKey } from 'node:crypto';

export type Jwks = { keys: JsonWebKey[] };

export type JwksCache = {
  get(): Promise<Jwks>;
  refresh(): Promise<Jwks>;
};

// Nested inside a caller's own request budget (node-socket's whoami fallback, capsule's proxy),
// so it must expire well before theirs or the client aborts first and the cause is never logged.
export const DEFAULT_TIMEOUT_MS = 1_500;
export const FAILURE_COOLDOWN_MS = 10_000;

export function createJwksCache(opts: { authOrigin: string; timeoutMs?: number }): JwksCache {
  const url = `${opts.authOrigin.replace(/\/$/, '')}/api/auth/jwks`;
  let cached: Jwks | null = null;
  let inflight: Promise<Jwks> | null = null;
  let failedUntil = 0;

  async function load(): Promise<Jwks> {
    // `cache` isn't in undici's RequestInit (Node) but is honored on Edge; keep it via a widened literal.
    const init: RequestInit & { cache?: string } = {
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`jwks fetch failed: ${response.status}`);
    }
    const body = (await response.json()) as Jwks;
    if (!body || !Array.isArray(body.keys)) {
      throw new Error('jwks response has no keys array');
    }
    return body;
  }

  async function fetchOnce(): Promise<Jwks> {
    if (inflight) return inflight;
    // Without this, an unreachable endpoint costs every caller the full timeout instead of one.
    if (Date.now() < failedUntil) {
      throw new Error('jwks fetch failed recently; cooling down');
    }
    inflight = load()
      .then((jwks) => { cached = jwks; failedUntil = 0; return jwks; })
      .catch((err: unknown) => { failedUntil = Date.now() + FAILURE_COOLDOWN_MS; throw err; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return {
    async get() { return cached ?? fetchOnce(); },
    async refresh() { cached = null; return fetchOnce(); },
  };
}
