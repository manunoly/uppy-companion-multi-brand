import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeValidEnv } from '../../test-utils/env-fixtures.js';
import { makeBrand, makeUser } from '../../test-utils/fixtures.js';

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

const abeVerify = vi.fn();
vi.mock('./abe-session-verifier.js', () => ({
    getAbeSessionVerifier: vi.fn(() => ({ verify: (...args: unknown[]) => abeVerify(...args) })),
}));

const { getRedis, closeRedis } = await import('../../lib/redis.js');
const { logger } = await import('../../lib/logger.js');
const { getAbeSessionVerifier } = await import('./abe-session-verifier.js');
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
        expect(breaker.isOpen).not.toHaveBeenCalled();
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

    it('abe (requireVerifiedEmail:true) + emailVerified:true -> authenticated and the user is cached', async () => {
        const abe = makeBrand({ slug: 'abe', auth: { requireVerifiedEmail: true } });
        const redis = getRedis();
        const setSpy = vi.spyOn(redis, 'set');
        globalThis.fetch = vi.fn(async () =>
            new Response(
                JSON.stringify({ id: 'cuid123', email: 'a@b.com', name: 'A', imageUrl: null, emailVerified: true }),
                { status: 200 },
            ),
        );

        const result = await resolveSession(abe, 'session=abc');
        expect(result.status).toBe('authenticated');
        expect(setSpy).toHaveBeenCalledTimes(1);
        setSpy.mockRestore();

        // Second call with the SAME cookie -> cache hit, no additional fetch (proves the write landed).
        const result2 = await resolveSession(abe, 'session=abc');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(result2.status).toBe('authenticated');
    });

    it('abe (requireVerifiedEmail:true) + emailVerified:false -> unauthenticated, no breaker failure, NOTHING cached', async () => {
        const abe = makeBrand({ slug: 'abe', auth: { requireVerifiedEmail: true } });
        const redis = getRedis();
        const setSpy = vi.spyOn(redis, 'set');
        globalThis.fetch = vi.fn(async () =>
            new Response(
                JSON.stringify({ id: 'cuid123', email: 'a@b.com', name: 'A', imageUrl: null, emailVerified: false }),
                { status: 200 },
            ),
        );

        const result = await resolveSession(abe, 'session=abc');
        expect(result.status).toBe('unauthenticated');
        // Partner answered fine (200 + valid whoami shape) -> the breaker stays healthy.
        expect(breaker.recordSuccess).toHaveBeenCalledTimes(1);
        expect(breaker.recordFailure).not.toHaveBeenCalled();
        expect(setSpy).not.toHaveBeenCalled();
        setSpy.mockRestore();
    });

    it('a brand WITHOUT requireVerifiedEmail (edo) + emailVerified:false -> still authenticated (ungated back-compat)', async () => {
        const edoBrand = makeBrand({ slug: 'edo' });
        globalThis.fetch = vi.fn(async () =>
            new Response(JSON.stringify({ id: '1004', email: 'a@b.com', name: 'A', emailVerified: false }), { status: 200 }),
        );

        const result = await resolveSession(edoBrand, 'session=abc');
        expect(result.status).toBe('authenticated');
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

    it('4xx other than 401/403 -> unavailable + recordFailure', async () => {
        globalThis.fetch = vi.fn(async () => new Response('nope', { status: 400 }));
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

    it('whoami 403 -> unauthenticated, and the breaker records a SUCCESS (upstream is healthy)', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 403 }));

        const result = await resolveSession(edo, 'session=abc');

        expect(result.status).toBe('unauthenticated');
        expect(breaker.recordSuccess).toHaveBeenCalled();
        expect(breaker.recordFailure).not.toHaveBeenCalled();
    });

    it('whoami 429 -> unavailable and a FAILURE — never clear a brake the partner just asked for', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 429 }));

        const result = await resolveSession(edo, 'session=abc');

        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalled();
        expect(breaker.recordSuccess).not.toHaveBeenCalled();
    });

    it('whoami 404 -> unavailable and a FAILURE (a moved whoami route must be visible, not a silent 401)', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 404 }));

        const result = await resolveSession(edo, 'session=abc');

        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalled();
        expect(breaker.recordSuccess).not.toHaveBeenCalled();
    });

    it('whoami 500 -> unavailable, and the breaker records a FAILURE', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 500 }));

        const result = await resolveSession(edo, 'session=abc');

        expect(result.status).toBe('unavailable');
        expect(breaker.recordFailure).toHaveBeenCalled();
    });

    it('a cached identity resolves even while the breaker is OPEN (cache is read first)', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            new Response(JSON.stringify({ id: 'u1', email: 'a@b.test', name: 'A', imageUrl: null }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        // Warm the cache with the breaker closed.
        const first = await resolveSession(edo, 'session=abc');
        expect(first.status).toBe('authenticated');

        // Now the partner goes down hard and the breaker opens.
        vi.mocked(breaker.isOpen).mockResolvedValue(true);
        vi.mocked(globalThis.fetch).mockClear();

        const second = await resolveSession(edo, 'session=abc');

        expect(second.status).toBe('authenticated');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

// closeRedis is exercised by every other file's own suite (redis.test.ts); no
// afterAll teardown needed here beyond letting Vitest tear down the process.
void closeRedis;

describe('resolveSession — abe (kind: capsule)', () => {
    // Mirrors registry.ts's abe entry, requireVerifiedEmail included — without it every
    // fallback case below would exercise a configuration production never runs.
    const abeAuth = {
        kind: 'capsule',
        whoamiUrl: 'https://api.test.example.com/auth/me',
        whoamiAllowedHosts: ['test.example.com'],
        authIssuer: 'https://auth.test.example.com',
        authAllowedHosts: ['test.example.com'],
        requireVerifiedEmail: true,
    } as const;
    const abe = makeBrand({ slug: 'abe', auth: { ...abeAuth } });
    const token = '__Secure-better-auth.session_token=tok.sig';
    const whoamiOk = () =>
        new Response(
            JSON.stringify({ id: 'u1', email: 'a@b.test', displayName: 'A', imageUrl: null, emailVerified: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );

    beforeEach(async () => {
        await getRedis().flushall();
        vi.mocked(breaker.isOpen).mockReset().mockResolvedValue(false);
        vi.mocked(breaker.recordSuccess).mockReset();
        vi.mocked(breaker.recordFailure).mockReset();
        vi.stubGlobal('fetch', vi.fn());
        abeVerify.mockReset();
        vi.mocked(getAbeSessionVerifier).mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('no Better Auth credential at all -> unauthenticated, nothing else runs', async () => {
        const result = await resolveSession(abe, 'unrelated=1');

        expect(result.status).toBe('unauthenticated');
        expect(abeVerify).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('a locally valid session resolves with NO fetch, NO cache and NO breaker', async () => {
        // The shape Task 6 actually returns — a complete BrandUser, not a bare id. Asserting only
        // on `status` here would let `user: undefined` through green.
        const user = makeUser({ id: 'u1' });
        abeVerify.mockResolvedValue({ status: 'valid', user, emailVerified: true });

        const result = await resolveSession(abe, token);

        expect(result).toEqual({ status: 'authenticated', user });
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(breaker.isOpen).not.toHaveBeenCalled();
    });

    it('requireVerifiedEmail rejects a locally valid session with an unverified email', async () => {
        abeVerify.mockResolvedValue({ status: 'valid', user: makeUser({ id: 'u1' }), emailVerified: false });

        const result = await resolveSession(abe, token);

        expect(result.status).toBe('unauthenticated');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('the local verifier is looked up with THIS brand, and a null one still reaches the whoami', async () => {
        vi.mocked(getAbeSessionVerifier).mockReturnValueOnce(null);
        vi.mocked(globalThis.fetch).mockResolvedValue(whoamiOk());

        const result = await resolveSession(abe, token);

        expect(getAbeSessionVerifier).toHaveBeenCalledWith(abe);
        expect(abeVerify).not.toHaveBeenCalled();
        expect(result.status).toBe('authenticated');
    });

    it('unavailable falls through to the whoami and NEVER touches the breaker for the local failure', async () => {
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'unavailable' });
        vi.mocked(globalThis.fetch).mockResolvedValue(whoamiOk());

        const result = await resolveSession(abe, token);

        expect(result.status).toBe('authenticated');
        expect(globalThis.fetch).toHaveBeenCalled();
        expect(breaker.recordFailure).not.toHaveBeenCalled();
    });

    it('a JWKS outage warns once, not once per request', async () => {
        // The throttle floor is module state that outlives a test, so pin the clock past any
        // warning an earlier case already recorded.
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
        const warn = vi.spyOn(logger, 'warn');
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'unavailable' });
        vi.mocked(globalThis.fetch).mockResolvedValue(whoamiOk());

        await resolveSession(abe, token);
        await resolveSession(abe, token);
        await resolveSession(abe, token);

        expect(warn.mock.calls.filter(([, msg]) => String(msg).includes('unavailable'))).toHaveLength(1);
        vi.mocked(Date.now).mockRestore();
    });

    it('the whoami fallback still honours requireVerifiedEmail', async () => {
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'unavailable' });
        vi.mocked(globalThis.fetch).mockResolvedValue(
            new Response(JSON.stringify({ id: 'u1', email: 'a@b.test', displayName: 'A', imageUrl: null }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        expect((await resolveSession(abe, token)).status).toBe('unauthenticated');
    });

    it('a chunked cache cookie alongside its deletion marker still forwards the credential', async () => {
        // The jar Better Auth actually issues when session_data outgrows ~4050 bytes: an expired
        // plain cookie plus fresh .0/.1 chunks. A JWKS outage must degrade to the whoami here,
        // not 401 every chunked user.
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'unavailable' });
        vi.mocked(globalThis.fetch).mockResolvedValue(whoamiOk());

        const result = await resolveSession(
            abe,
            `${token}; __Secure-better-auth.session_data=; __Secure-better-auth.session_data.0=aaa; __Secure-better-auth.session_data.1=bbb`,
        );

        expect(result.status).toBe('authenticated');
        const forwarded = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_token=tok.sig');
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_data.0=aaa');
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_data.1=bbb');
    });

    it('poisoned falls through to the whoami and forwards BOTH cookies', async () => {
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'poisoned' });
        vi.mocked(globalThis.fetch).mockResolvedValue(whoamiOk());

        await resolveSession(abe, `${token}; __Secure-better-auth.session_data=jwt`);

        const forwarded = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_token=tok.sig');
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_data=jwt');
    });

    it('credential-mismatch forwards the CREDENTIAL ALONE — never the distrusted cache', async () => {
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'credential-mismatch' });
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 401 }));

        await resolveSession(abe, `${token}; __Secure-better-auth.session_data=jwt`);

        const forwarded = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_token=tok.sig');
        expect(forwarded.Cookie).not.toContain('session_data');
    });

    it('an anonymous request against a MISCONFIGURED brand is 401-shaped, not 403-shaped', async () => {
        // Pins the ordering property: credential presence is checked before the SSRF gate, so a
        // request with no cookie answers `unauthenticated`, never `misconfigured`. picaboo ships
        // whoamiUrl: '' by design, so this is its normal anonymous path.
        const broken = makeBrand({ slug: 'abe', auth: { ...abeAuth, whoamiUrl: '' } });

        expect((await resolveSession(broken, 'unrelated=1')).status).toBe('unauthenticated');
        expect((await resolveSession(makeBrand({ slug: 'edo', auth: { whoamiUrl: '' } }), 'nothing=1')).status).toBe(
            'unauthenticated',
        );
    });

    it('both cookie namespaces present -> the whoami decides, no local verify', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 401 }));

        await resolveSession(abe, `${token}; better-auth.session_token=other.sig`);

        expect(abeVerify).not.toHaveBeenCalled();
        expect(globalThis.fetch).toHaveBeenCalled();
    });
});
