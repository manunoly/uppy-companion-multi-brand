import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeValidEnv } from '../../test-utils/env-fixtures.js';
import { makeBrand } from '../../test-utils/fixtures.js';

// Cache layer (step 5) is real Redis logic under test — swap in ioredis-mock.
vi.mock('ioredis', async () => {
    const { default: RedisMock } = await import('ioredis-mock');
    return { default: RedisMock, Redis: RedisMock };
});
vi.mock('../../config/index.js', () => ({
    env: makeValidEnv({ redisUrl: 'redis://localhost:6379' }),
}));

// The breaker itself is unit-tested in isolation (whoami-breaker.test.ts) with
// real (mocked-Redis) logic. Here it's mocked outright so each session-resolver
// test can deterministically control isOpen()'s answer and assert exactly
// which of recordSuccess/recordFailure fired, without needing to first drive
// the breaker into a given state through 3 real failures.
vi.mock('./whoami-breaker.js', () => ({
    isOpen: vi.fn().mockResolvedValue(false),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    tryHalfOpen: vi.fn(),
}));

const { getRedis, closeRedis } = await import('../../lib/redis.js');
const breaker = await import('./whoami-breaker.js');
const { resolveSession } = await import('./session-resolver.js');

const edo = makeBrand({ slug: 'edo' });

describe('resolveSession (src/modules/auth/session-resolver.ts)', () => {
    beforeEach(async () => {
        await getRedis().flushall();
        vi.mocked(breaker.isOpen).mockReset().mockResolvedValue(false);
        vi.mocked(breaker.recordSuccess).mockReset();
        vi.mocked(breaker.recordFailure).mockReset();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('no cookie at all -> unauthenticated (no fetch, no breaker touch)', async () => {
        const result = await resolveSession(edo, undefined);
        expect(result.status).toBe('unauthenticated');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(breaker.isOpen).not.toHaveBeenCalled();
    });

    it('cookie header present but missing the brand cookie name -> unauthenticated', async () => {
        const result = await resolveSession(edo, 'other=value');
        expect(result.status).toBe('unauthenticated');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('malformed cookie value (contains ";") -> unauthenticated, and recordFailure is NEVER called', async () => {
        // A raw ";" inside the cookie VALUE can't happen via normal browser
        // cookie encoding, but a decoded/tampered value could carry one; the
        // buildCookieHeader gate (identity.ts) rejects it before the breaker.
        const brandWithInjectedValue = makeBrand({ slug: 'edo' });
        // Cookie header where the "session" cookie's value itself is malformed
        // once matched by our extractor: `session=abc;def` reads value "abc"
        // (correctly parsed as a separate cookie), so to exercise the
        // buildCookieHeader rejection we need extractCookieValue to hand back
        // a value containing a forbidden delimiter — a decoded CRLF is the
        // realistic attack (raw CR/LF bytes surviving decodeURIComponent).
        const result = await resolveSession(brandWithInjectedValue, 'session=abc%0d%0aInjected:1');
        expect(result.status).toBe('unauthenticated');
        expect(breaker.recordFailure).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('misconfigured whoami target (off-allowlist) -> misconfigured, no fetch, no breaker touch', async () => {
        const misconfigured = makeBrand({
            slug: 'edo',
            auth: { whoamiUrl: 'https://evil.example.com/user' },
        });
        const result = await resolveSession(misconfigured, 'session=tok');
        expect(result.status).toBe('misconfigured');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(breaker.isOpen).not.toHaveBeenCalled();
    });

    it('breaker open -> unavailable, without ever calling fetch', async () => {
        vi.mocked(breaker.isOpen).mockResolvedValue(true);
        const result = await resolveSession(edo, 'session=tok');
        expect(result.status).toBe('unavailable');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('200 -> authenticated, and enriches edoId + caches the full user (edo only)', async () => {
        const edoBrand = makeBrand({ slug: 'edo' });
        globalThis.fetch = vi.fn(async () =>
            new Response(JSON.stringify({ id: '1004', edo_id: 854569, email: 'a@b.com', name: 'A' }), { status: 200 }),
        );

        const r1 = await resolveSession(edoBrand, 'session=abc');
        expect(r1.status).toBe('authenticated');
        if (r1.status !== 'authenticated') throw new Error('unreachable');
        expect(r1.user.id).toBe('1004');
        expect(r1.user.edoId).toBe(854569);
        expect(breaker.recordSuccess).toHaveBeenCalledTimes(1);

        // Second call with the SAME cookie -> cache hit: no additional fetch,
        // edoId is retained (proves the FULL user, not just the id, is cached).
        const r2 = await resolveSession(edoBrand, 'session=abc');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(r2.status).toBe('authenticated');
        if (r2.status !== 'authenticated') throw new Error('unreachable');
        expect(r2.user.edoId).toBe(854569);
    });

    it('does NOT enrich edoId for a non-edo brand even if the whoami body carries edo_id', async () => {
        const abe = makeBrand({ slug: 'abe' });
        globalThis.fetch = vi.fn(async () =>
            new Response(JSON.stringify({ id: 'cuid123', edo_id: 999, email: 'a@b.com', name: 'A' }), { status: 200 }),
        );
        const result = await resolveSession(abe, 'session=abc');
        expect(result.status).toBe('authenticated');
        if (result.status !== 'authenticated') throw new Error('unreachable');
        expect(result.user.edoId).toBeUndefined();
    });

    it('401 -> unauthenticated, and recordSuccess is called (partner answered — circuit is healthy)', async () => {
        globalThis.fetch = vi.fn(async () => new Response(null, { status: 401 }));
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unauthenticated');
        expect(breaker.recordSuccess).toHaveBeenCalledTimes(1);
        expect(breaker.recordFailure).not.toHaveBeenCalled();
    });

    it('3xx (redirect:"manual" real 3xx) -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => new Response(null, { status: 302 }));
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('opaqueredirect (status 0) -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => ({ status: 0, type: 'opaqueredirect', ok: false }) as unknown as Response);
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('5xx -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 }));
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('4xx other than 401 -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => new Response('nope', { status: 403 }));
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('fetch throws (network error / AbortSignal.timeout firing) -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new DOMException('The operation was aborted.', 'TimeoutError');
        });
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('body over the 16KB cap -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => new Response('x'.repeat(20_000), { status: 200 }));
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('200 with a body that fails normalizeBrandUser (missing email) -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: '1004' }), { status: 200 }));
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('200 with a non-JSON body -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => new Response('not json', { status: 200 }));
        const result = await resolveSession(edo, 'session=abc');
        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });
});

// closeRedis is exercised by every other file's own suite (redis.test.ts); no
// afterAll teardown needed here beyond letting Vitest tear down the process.
void closeRedis;
