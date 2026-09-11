import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose';
import type { JwksCache } from './jwks.js';

export type VerifyOpts = {
  jwks: JwksCache;
  issuer: string;
  audience: string;
};

export type VerifiedJwt = { payload: JWTPayload };

// One unknown-kid retry makes key rotation transparent to callers.
async function importKeyForToken(token: string, cache: JwksCache) {
  const header = decodeProtectedHeader(token);
  if (!header.kid) return null;

  let keys = (await cache.get()).keys;
  let match = keys.find((key) => (key as { kid?: string }).kid === header.kid);
  if (!match) {
    keys = (await cache.refresh()).keys;
    match = keys.find((key) => (key as { kid?: string }).kid === header.kid);
  }
  if (!match) return null;

  const alg = (match as { alg?: string }).alg ?? header.alg;
  if (!alg) return null;
  return { alg, key: await importJWK(match, alg) };
}

export async function verifyJwt(token: string, opts: VerifyOpts): Promise<VerifiedJwt | null> {
  const resolved = await importKeyForToken(token, opts.jwks);
  if (!resolved) return null;
  const { payload } = await jwtVerify(token, resolved.key, {
    issuer: opts.issuer,
    audience: opts.audience,
    algorithms: [resolved.alg],
    clockTolerance: 15,
  });
  return { payload };
}

export async function verifyAccessToken(
  token: string,
  opts: VerifyOpts,
): Promise<{ userId: string } | null> {
  try {
    const verified = await verifyJwt(token, opts);
    if (typeof verified?.payload.sub !== 'string') return null;
    return { userId: verified.payload.sub };
  } catch {
    return null;
  }
}
