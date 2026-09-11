import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose';
import type { JsonWebKey } from 'node:crypto';
import type { JwksCache } from './jwks.js';

export const SESSION_COOKIE_CACHE_AUDIENCE = 'better-auth:session-cache';
const SESSION_COOKIE_CACHE_TYP = 'better-auth.session-cache+jwt';
const CLOCK_TOLERANCE_SECONDS = 15;
// Matches @better-auth/core's date reviver exactly (json.mjs's iso8601Regex).
const ISO_DATE_TIME_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export type SessionUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
  image?: string | null;
};

export type SessionCookieResult =
  | { status: 'valid'; user: SessionUser; session: Record<string, unknown> }
  | { status: 'absent' }
  | { status: 'expired' }
  | { status: 'poisoned' }
  // The JWT verified but is not backed by the credential presented alongside it. Distinct from
  // 'poisoned' (nothing is wrong with the token) and from 'absent' (a session_data IS present):
  // only an authoritative read of the credential can settle this jar.
  | { status: 'credential-mismatch' }
  | { status: 'unavailable' };

export type SessionCookieOpts = {
  jwks: JwksCache;
  issuer: string;
  sessionDataName: string;
  // Required, not optional: the binding is the difference between verifying a token and
  // authenticating a session, and an opt-in check is one every future consumer can forget.
  sessionTokenName: string;
};

function rawCookie(headers: Headers, name: string): string | null {
  const header = headers.get('cookie');
  if (!header) return null;
  const chunks: { index: number; value: string }[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    // An empty plain cookie is a deletion marker, not a value: Better Auth expires it in the same
    // response that issues fresh chunks. Returning it here would mask them and read as 'absent'.
    if (key === name && value !== '') return value;
    if (key.startsWith(`${name}.`)) {
      const index = Number.parseInt(key.split('.').at(-1) ?? '', 10);
      if (!Number.isNaN(index)) chunks.push({ index, value });
    }
  }
  if (chunks.length === 0) return null;
  return chunks.sort((a, b) => a.index - b.index).map((chunk) => chunk.value).join('');
}

function isExpired(token: string): boolean {
  const toleranceMs = CLOCK_TOLERANCE_SECONDS * 1000;
  const claims = decodeJwt(token);
  if (typeof claims.exp === 'number' && claims.exp * 1000 + toleranceMs <= Date.now()) return true;
  const session = (claims as { session?: { expiresAt?: unknown } }).session;
  if (typeof session?.expiresAt === 'string') {
    const expiresAt = new Date(session.expiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt + toleranceMs <= Date.now()) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsableJwk(entry: JsonWebKey): entry is JsonWebKey & { kid: string } {
  return isRecord(entry) && typeof (entry as { kid?: unknown }).kid === 'string';
}

function isSessionExpired(session: Record<string, unknown>): boolean {
  const { expiresAt } = session;
  if (typeof expiresAt !== 'string') return false;
  const ms = new Date(expiresAt).getTime();
  return Number.isFinite(ms) && ms < Date.now();
}

// The one reader of a Better Auth user object, whether it arrived in the session-cache JWT or in a
// `get-session` response body. Both carry the same row; parsing them by different rules made the
// same account resolve differently depending on which path served the request.
export function parseSessionUser(value: unknown): SessionUser | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.email !== 'string') return null;
  // better-auth declares emailVerified required with defaultValue false, so absent should never
  // reach us; if it does, verification is unproven — not grounds to discard a usable identity.
  if (value.emailVerified !== undefined && typeof value.emailVerified !== 'boolean') return null;

  return {
    id: value.id,
    // better-auth's schema lowercases it.
    email: value.email.toLowerCase(),
    emailVerified: value.emailVerified ?? false,
    name: typeof value.name === 'string' ? value.name : null,
    image: typeof value.image === 'string' ? value.image : null,
  };
}

function parseSessionPayload(
  payload: JWTPayload,
): { user: SessionUser; session: Record<string, unknown> } | null {
  const { user, session, sid, iss, sub } = payload as {
    user?: unknown; session?: unknown; sid?: unknown; iss?: unknown; sub?: unknown;
  };
  if (!isRecord(session)) return null;
  const parsedUser = parseSessionUser(user);
  if (!parsedUser) return null;
  if (typeof iss !== 'string' || iss.length === 0) return null;
  if (typeof session.token !== 'string' || typeof sid !== 'string') return null;
  if (sub !== parsedUser.id || sid !== session.token) return null;
  if (typeof session.expiresAt !== 'string' || !ISO_DATE_TIME_Z.test(session.expiresAt)
    || !Number.isFinite(new Date(session.expiresAt).getTime())) return null;

  return { user: parsedUser, session };
}

// Better Auth signs the credential as `<token>.<signature>`; the token itself carries no '.'.
function presentedCredential(headers: Headers, name: string): string | null {
  const raw = rawCookie(headers, name);
  if (!raw) return null;
  const [value] = raw.split('.');
  return value || null;
}

export async function verifySessionCookie(
  headers: Headers,
  opts: SessionCookieOpts,
): Promise<SessionCookieResult> {
  const token = rawCookie(headers, opts.sessionDataName);
  if (!token) return { status: 'absent' };

  // Before the JWKS round-trip: a session_data with no credential behind it cannot authenticate
  // anything, however well it verifies.
  const presented = presentedCredential(headers, opts.sessionTokenName);
  if (!presented) return { status: 'credential-mismatch' };

  try {
    const header = decodeProtectedHeader(token);
    if (header.typ !== SESSION_COOKIE_CACHE_TYP) return { status: 'poisoned' };
    if (isExpired(token)) return { status: 'expired' };
  } catch {
    return { status: 'poisoned' };
  }

  let keys;
  try {
    keys = await opts.jwks.get();
  } catch {
    return { status: 'unavailable' };
  }

  const header = decodeProtectedHeader(token);
  if (!header.kid) return { status: 'poisoned' };
  if (!keys.keys.some((key) => isUsableJwk(key) && key.kid === header.kid)) {
    try {
      keys = await opts.jwks.refresh();
    } catch {
      return { status: 'unavailable' };
    }
  }

  const key = keys.keys.find((entry) => isUsableJwk(entry) && entry.kid === header.kid);
  if (!key) {
    return keys.keys.some(isUsableJwk) ? { status: 'poisoned' } : { status: 'unavailable' };
  }
  const alg = (key as { alg?: string }).alg ?? header.alg;
  if (!alg) return { status: 'poisoned' };

  let importedKey: Awaited<ReturnType<typeof importJWK>>;
  try {
    importedKey = await importJWK(key, alg);
  } catch {
    return { status: 'unavailable' };
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, importedKey, {
      algorithms: [alg],
      audience: SESSION_COOKIE_CACHE_AUDIENCE,
      issuer: opts.issuer,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }));
  } catch {
    return { status: 'poisoned' };
  }

  const parsed = parseSessionPayload(payload);
  if (!parsed) return { status: 'poisoned' };
  if (isSessionExpired(parsed.session)) return { status: 'expired' };
  if (parsed.session.token !== presented) return { status: 'credential-mismatch' };
  return { status: 'valid', user: parsed.user, session: parsed.session };
}
