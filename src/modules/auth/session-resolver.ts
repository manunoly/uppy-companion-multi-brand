import { createHash } from 'node:crypto';
import type { Brand, BrandUser } from '../brand/brand.contract.js';
import {
    buildCookieHeader,
    normalizeBrandUser,
    resolveEffectiveAuth,
    resolveEffectiveSessionCookieName,
    resolveValidatedWhoamiTarget,
    WHOAMI_MAX_BODY_BYTES,
    WHOAMI_TIMEOUT_MS,
} from '../brand/identity.js';
import { getRedis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import * as breaker from './whoami-breaker.js';
import { enrichEdoUser } from './enrich-edo.js';

export type SessionResolution =
    | { status: 'authenticated'; user: BrandUser }
    | { status: 'unauthenticated' }
    | { status: 'unavailable'; reason: string }
    | { status: 'misconfigured'; reason: string };

const CACHE_TTL_SECONDS = 45;
const CACHE_NAMESPACE = 'companion-whoami'; // own namespace — does NOT collide with node-socket's `socket-whoami:`

function cacheKeyFor(slug: string, cookieValue: string): string {
    const hash = createHash('sha256').update(cookieValue).digest('hex');
    return `${CACHE_NAMESPACE}:${slug}:${hash}`;
}

/**
 * Narrow named-cookie extractor over a raw `Cookie` header string. The name is
 * regex-escaped so an unusual (but allowlisted) cookie name can never be
 * interpreted as part of the pattern. Ported from abeduls3's node-socket
 * `extractCookie.ts`.
 */
function extractCookieValue(cookieHeader: string | undefined | null, name: string): string | null {
    if (!cookieHeader) return null;
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|;\\s*)${escapedName}=([^;]+)`).exec(cookieHeader);
    const rawValue = match?.[1];
    if (!rawValue) return null;
    try {
        return decodeURIComponent(rawValue);
    } catch {
        return rawValue;
    }
}

/**
 * True byte cap on the whoami body: cancels the stream the instant it exceeds
 * `maxBytes`, instead of buffering the whole body then checking length (a
 * `Content-Length` header is bypassable; a post-read length check would still
 * materialize the full body first). Falls back to `response.text()` for
 * Response-like objects without a real stream (some test doubles) — the cap
 * is enforced post-hoc in that case, which is safe for tests but real `fetch`
 * responses always carry a `.body` stream so production always takes the
 * streaming path.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string | null> {
    const declaredLength = response.headers?.get?.('content-length');
    if (declaredLength !== null && declaredLength !== undefined) {
        const n = Number(declaredLength);
        if (Number.isFinite(n) && n > maxBytes) return null;
    }

    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
        const text = await response.text();
        return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } catch {
        return null;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return Buffer.from(merged).toString('utf8');
}

/**
 * Resolves the caller's session for `brand` by forwarding its session cookie
 * to the brand's whoami endpoint. The ORDER of the steps below is a security
 * property, not an implementation detail (spec D5.a / plan Task 3.2) —
 * faithfully mirrors abeduls3's `resolvePartnerSocketIdentity.ts:44-73`:
 *
 *   1. Extract the raw cookie VALUE by the brand's effective cookie name.
 *   2. SSRF gate (resolveValidatedWhoamiTarget) — before anything else
 *      touches the network; `misconfigured` never falls through to fetch.
 *   3. Build the forwarded `Cookie:` header — a malformed/delimiter-bearing
 *      value is a CLIENT error (`unauthenticated`) and must NEVER touch the
 *      breaker, else an unauthenticated attacker could open it for every
 *      user of the brand by spamming malformed cookies (auth DoS). This MUST
 *      precede step 4.
 *   4. Circuit breaker — fail-fast BEFORE the cache/fetch.
 *   5. Redis cache (namespace `companion-whoami:`, TTL 45s, full serialized
 *      `BrandUser` — needed to retain `edoId`/email on a cache hit).
 *   6. Forward the cookie to the whoami endpoint (`redirect:'manual'`, 5s
 *      timeout).
 *   7. Interpret the response status (every redirect form is failure).
 *   8. Body cap (16 KB) via streaming — never trust `Content-Length` alone.
 *   9. Normalize, apply the registry email-verified gate (unverified ⇒
 *      unauthenticated, never cached), then (edo-only) enrich with
 *      `edoId`/parsed email.
 */
export async function resolveSession(
    brand: Brand,
    cookieHeader: string | undefined | null,
): Promise<SessionResolution> {
    const slug = brand.slug;

    // 1. Extract the raw cookie VALUE by the brand's effective cookie name.
    const cookieName = resolveEffectiveSessionCookieName(brand);
    const cookieValue = extractCookieValue(cookieHeader, cookieName);
    if (cookieValue === null) return { status: 'unauthenticated' };

    // 2. SSRF gate: validate + allowlist the whoami target BEFORE anything
    // else touches the network. Never falls through to fetch on failure.
    const target = resolveValidatedWhoamiTarget(brand);
    if (!target.ok) {
        logger.error({ slug, reason: target.reason }, '[auth] whoami target misconfigured');
        return { status: 'misconfigured', reason: target.reason };
    }

    // 3. Build the forwarded Cookie header. MUST precede the breaker check.
    const forwardedCookie = buildCookieHeader(target.sessionCookieName, cookieValue);
    if (forwardedCookie === null) return { status: 'unauthenticated' };

    // 4. Circuit breaker — fail-fast BEFORE the cache/fetch.
    if (await breaker.isOpen(slug)) {
        return { status: 'unavailable', reason: 'breaker open' };
    }

    // 5. Redis cache — full serialized BrandUser, only ever written on success.
    const cacheKey = cacheKeyFor(slug, cookieValue);
    const redis = getRedis();
    try {
        const cached = await redis.get(cacheKey);
        if (cached !== null) {
            const user = JSON.parse(cached) as BrandUser;
            return { status: 'authenticated', user };
        }
    } catch (err) {
        logger.warn({ err, slug }, '[auth] whoami cache read failed; falling through to fetch');
    }

    // 6. Forward the cookie to the whoami endpoint.
    let response: Response;
    try {
        response = await fetch(target.whoamiUrl.toString(), {
            method: 'GET',
            headers: { Cookie: forwardedCookie },
            redirect: 'manual',
            signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
        });
    } catch (err) {
        logger.warn({ err, slug }, '[auth] whoami fetch failed');
        await breaker.recordFailure(slug);
        return { status: 'unavailable', reason: 'whoami fetch failed' };
    }

    // 7. Interpret status — every redirect form is failure (redirect:'manual'
    // can yield an opaque status-0/opaqueredirect response, or the raw 3xx on
    // some undici versions).
    if (response.status === 0 || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await breaker.recordFailure(slug);
        return { status: 'unavailable', reason: 'whoami redirect' };
    }
    if (response.status === 401) {
        await breaker.recordSuccess(slug); // partner answered — circuit is healthy
        return { status: 'unauthenticated' };
    }
    if (!response.ok) {
        await breaker.recordFailure(slug);
        return { status: 'unavailable', reason: `whoami ${response.status}` };
    }

    // 8. Body cap (16 KB) via streaming.
    const text = await readBodyCapped(response, WHOAMI_MAX_BODY_BYTES);
    if (text === null) {
        await breaker.recordFailure(slug);
        return { status: 'unavailable', reason: 'whoami body cap' };
    }

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        await breaker.recordFailure(slug);
        return { status: 'unavailable', reason: 'whoami body parse' };
    }

    // 9. Normalize, gate on verified email, then (edo-only) enrich.
    const effectiveAuth = resolveEffectiveAuth(brand);
    const normalized = normalizeBrandUser(effectiveAuth.responseMapping, json);
    if (!normalized) {
        logger.warn({ slug }, '[auth] normalizeBrandUser returned null — whoami response mapping mismatch');
        await breaker.recordFailure(slug);
        return { status: 'unavailable', reason: 'whoami shape' };
    }

    await breaker.recordSuccess(slug);

    // Registry email-verified gate: unverified resolves unauthenticated, never cached (breaker already healthy).
    if (effectiveAuth.requireVerifiedEmail && (json as Record<string, unknown>).emailVerified !== true) {
        return { status: 'unauthenticated' };
    }

    const user: BrandUser = slug === 'edo' ? enrichEdoUser(normalized, json) : normalized;

    try {
        await redis.set(cacheKey, JSON.stringify(user), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
        logger.warn({ err, slug }, '[auth] whoami cache write failed');
    }

    return { status: 'authenticated', user };
}
