import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createTestApp } from './test-utils/http.js';
import { makeBrand } from './test-utils/fixtures.js';
import { makeValidEnv } from './test-utils/env-fixtures.js';

// Readiness (Task 1.3) checks Redis via `getRedis().ping()` — swap in
// ioredis-mock so those requests never touch the network.
vi.mock('ioredis', async () => {
    const { default: RedisMock } = await import('ioredis-mock');
    return { default: RedisMock, Redis: RedisMock };
});
// `getRedis()` (lib/redis.ts) eagerly reads `env` from `config/index.js` at
// import time — mocked statically (hoisted, so it's in effect for the very
// first `beforeEach`'s `getRedis()` flush too, unlike `createTestApp`'s own
// per-test `vi.doMock`, which only takes effect from that call onward).
vi.mock('./config/index.js', () => ({
    env: makeValidEnv(),
}));
// `rate-limit-redis`'s Store does its atomic increment via a Lua script
// (SCRIPT LOAD + EVALSHA) — `ioredis-mock` implements `.script()`/`.evalsha()`
// as functions but doesn't actually execute Lua (throws "Unsupported command:
// script"). Swap in a minimal in-memory Store satisfying the SAME
// `express-rate-limit` Store contract `buildRateLimiter` (server.ts) wires up,
// so the 429-after-N-requests behavior is exercised faithfully without
// depending on genuine server-side Lua support from the test double. This
// mirrors the spec's own noted limitation of ioredis-mock as "a weaker signal
// than real Redis for security logic" (§8) — real Redis via testcontainers is
// listed as a future improvement (Fase 8.9), not something this suite does.
vi.mock('rate-limit-redis', () => {
    class InMemoryStoreForTests {
        private hits = new Map<string, number>();
        async increment(key: string) {
            const totalHits = (this.hits.get(key) ?? 0) + 1;
            this.hits.set(key, totalHits);
            return { totalHits, resetTime: new Date(Date.now() + 60_000) };
        }
        async decrement(key: string) {
            this.hits.set(key, Math.max(0, (this.hits.get(key) ?? 0) - 1));
        }
        async resetKey(key: string) {
            this.hits.delete(key);
        }
    }
    return { RedisStore: InMemoryStoreForTests, default: InMemoryStoreForTests };
});

const s3Mock = mockClient(S3Client);

// Real companionHosts entry for `edo` in the code-only base registry
// (modules/brand/registry.ts) — Host-based resolution (Fase 5.1/D4) is keyed
// against THIS registry, not against whatever `makeBrand()` fixture fields a
// test passes to `createTestApp`. `req.brand` itself still comes from the
// fixture (via the slug match), so brand-specific overrides (auth.signInUrl,
// limits, s3, etc.) still take effect.
const EDO_HOST = 'companion.stage.entourageyearbooks.com';

describe('server integration', () => {
    beforeEach(async () => {
        vi.stubGlobal('fetch', vi.fn());
        vi.stubEnv('BRAND_FORCE', '');
        s3Mock.reset();
        s3Mock.on(HeadBucketCommand).resolves({});
        // Rate-limit counters (Fase 5.2) and the whoami/breaker state live in
        // the same shared ioredis-mock singleton across every test in this
        // file — flush so one test's request volume can never tip another's
        // rate-limit assertions.
        const { getRedis } = await import('./lib/redis.js');
        await getRedis().flushall();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('GET /api/healthz → 200 with status:ok', async () => {
        const { app } = await createTestApp();
        const res = await request(app).get('/api/healthz');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('GET /api/brands without key → returns basic info only', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({ slug: 'edo', name: 'Test' })],
        });
        const res = await request(app).get('/api/brands');
        expect(res.status).toBe(200);
        expect(res.body.detailedView).toBe(false);
        expect(res.body.brands).toEqual([{ id: 'edo', displayName: 'Test' }]);
    });

    it('GET /api/brands with wrong key → still 200 with basic info', async () => {
        const env = makeValidEnv({ healthCheckKey: 'correct-key' });
        const { app } = await createTestApp({ env });
        const res = await request(app).get('/api/brands').query({ key: 'wrong' });
        expect(res.status).toBe(200);
        expect(res.body.detailedView).toBe(false);
    });

    it('GET /api/brands with correct key → returns detailed info with masked secrets', async () => {
        const env = makeValidEnv({ healthCheckKey: 'correct-key' });
        const { app } = await createTestApp({
            env,
            brands: [makeBrand({
                slug: 'edo',
                s3: {
                    bucket: 'b',
                    region: 'us-east-1',
                    accessKey: 'AKIATESTKEY',
                    secretKey: 'verysecretvalue',
                    useAccelerateEndpoint: false,
                },
            })],
        });
        const res = await request(app).get('/api/brands').query({ key: 'correct-key' });
        expect(res.status).toBe(200);
        expect(res.body.detailedView).toBe(true);
        const brand = res.body.brands[0];
        expect(brand.s3.bucket).toBe('b');
        expect(brand.s3.accessKey).toMatch(/^\*+\.\.\.\w{4}$/);
        expect(brand.s3.secretKey).toMatch(/^\*+\.\.\.\w{4}$/);
    });

    it('GET /uppy without a session → 302 to auth.signInUrl with redirect param', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({
                slug: 'edo',
                auth: { signInUrl: 'https://app.test.example.com/login' },
            })],
        });
        const res = await request(app).get('/uppy').set('Host', EDO_HOST);
        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/^https:\/\/app\.test\.example\.com\/login\?redirect=/);
    });

    it('GET /uppy without a session + no signInUrl → 401 static page', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({
                slug: 'edo',
                auth: { signInUrl: '' },
            })],
        });
        const res = await request(app).get('/uppy').set('Host', EDO_HOST);
        expect(res.status).toBe(401);
        expect(res.text).toContain('Session Expired');
    });

    it('GET /uppy with a valid session → 200 HTML with no-store cache', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
            new Response(
                JSON.stringify({ id: 'u123', email: 'test@example.com', name: 'Test User', imageUrl: null }),
                { status: 200 },
            ),
        );
        const { app } = await createTestApp({
            brands: [makeBrand({ slug: 'edo' })],
        });
        const res = await request(app).get('/uppy').set('Host', EDO_HOST).set('Cookie', 'session=valid-session-token');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.text.toLowerCase()).toContain('<!doctype html>');
    });

    it('GET /uppy page points the client at the brand companionUrl, not a retired /{slug}/ path prefix', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
            new Response(
                JSON.stringify({ id: 'u123', email: 'test@example.com', name: 'Test User', imageUrl: null }),
                { status: 200 },
            ),
        );
        const { app } = await createTestApp({
            brands: [makeBrand({ slug: 'edo', companionUrl: 'https://companion.example.com' })],
        });
        const res = await request(app).get('/uppy').set('Host', EDO_HOST).set('Cookie', 'session=valid-session-token');
        expect(res.status).toBe(200);
        // uppyModal.ts does `fetch(`${SERVER_URL}/api/uppy/sign-s3`, ...)` — a
        // literal '/edo' (the old per-brand mount path, Fase 5.1 retires it)
        // would 404 under Host-based routing since the server no longer
        // mounts anything under that prefix.
        expect(res.text).not.toContain("'/edo'");
        expect(res.text).toContain("'https://companion.example.com'");
    });

    // Fase 5.4: SRI on the pinned CDN assets + a CSP nonce on the inline
    // <script type="module">. Motive (audit finding, ALTO): uppy.html's
    // inline module script imports ./uppyModal.js and reads the
    // server-injected placeholders — Task 5.2's `script-src 'self'` CSP
    // would BLOCK it outright without a nonce (and 'unsafe-inline' would
    // defeat the CSP's purpose entirely).
    describe('SRI + CSP nonce (Fase 5.4)', () => {
        const authOk = () => {
            (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
                new Response(
                    JSON.stringify({ id: 'u123', email: 'test@example.com', name: 'Test User', imageUrl: null }),
                    { status: 200 },
                ),
            );
        };

        it('every pinned CDN <link>/<script> carries integrity + crossorigin="anonymous"', async () => {
            authOk();
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app).get('/uppy').set('Host', EDO_HOST).set('Cookie', 'session=valid-session-token');
            expect(res.status).toBe(200);

            const cdnUrls = [
                'https://releases.transloadit.com/uppy/v5.1.8/uppy.min.css',
                'https://releases.transloadit.com/uppy/v5.1.8/uppy.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/sweetalert2/11.23.0/sweetalert2.min.css',
                'https://cdnjs.cloudflare.com/ajax/libs/sweetalert2/11.23.0/sweetalert2.min.js',
            ];
            for (const url of cdnUrls) {
                const escaped = url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
                const tagRegex = new RegExp(`${escaped}"[^>]*integrity="sha384-[A-Za-z0-9+/=]+"[^>]*crossorigin="anonymous"`);
                expect(res.text).toMatch(tagRegex);
            }
        });

        it('the inline <script type="module"> nonce equals the CSP header nonce (mismatch would silently break Uppy under CSP)', async () => {
            authOk();
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app).get('/uppy').set('Host', EDO_HOST).set('Cookie', 'session=valid-session-token');
            expect(res.status).toBe(200);

            const csp = res.headers['content-security-policy'];
            const headerNonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp ?? '')?.[1];
            expect(headerNonce).toBeTruthy();

            const scriptNonce = /<script type="module" nonce="([^"]+)">/.exec(res.text)?.[1];
            expect(scriptNonce).toBeTruthy();
            expect(scriptNonce).toBe(headerNonce);
        });
    });

    it('GET /uppy on an unrecognized Host → 404 (never falls back to a default brand)', async () => {
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app).get('/uppy').set('Host', 'evil.example.com');
        expect(res.status).toBe(404);
    });

    it('GET /uppy with BRAND_FORCE=edo routes to edo regardless of Host', async () => {
        vi.stubEnv('BRAND_FORCE', 'edo');
        const { app } = await createTestApp({
            brands: [makeBrand({ slug: 'edo', auth: { signInUrl: '' } })],
        });
        const res = await request(app).get('/uppy').set('Host', 'anything.example.com');
        expect(res.status).toBe(401);
        expect(res.text).toContain('Session Expired');
    });

    it('OPTIONS /api/uppy/sign-s3 with valid origin → 204 with CORS headers', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({ slug: 'edo' })],
        });
        const res = await request(app)
            .options('/api/uppy/sign-s3')
            .set('Host', EDO_HOST)
            .set('Origin', 'http://app.test.example.com');
        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
        expect(res.headers['access-control-allow-origin']).toBe('http://app.test.example.com');
    });

    describe('GET /api/readyz', () => {
        it('→ 200 when Redis PING and S3 HeadBucket both succeed', async () => {
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app).get('/api/readyz');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ok');
        });

        it('→ 503 when the S3 HeadBucket check fails', async () => {
            s3Mock.on(HeadBucketCommand).rejects(new Error('bucket unreachable'));
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app).get('/api/readyz');
            expect(res.status).toBe(503);
            expect(res.body.s3).toBe(false);
        });

        it('→ 503 when the S3 HeadBucket check times out', async () => {
            s3Mock.on(HeadBucketCommand).callsFake(() => new Promise(() => {
                // Never resolves — exercises the readyz S3 check's own short timeout.
            }));
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app).get('/api/readyz');
            expect(res.status).toBe(503);
            expect(res.body.s3).toBe(false);
        }, 10_000);

        it('→ 503 when the app is marked as shutting down', async () => {
            const { app, setShuttingDown } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            setShuttingDown(true);
            const res = await request(app).get('/api/readyz');
            expect(res.status).toBe(503);
        });
    });

    describe('GET /api/healthz during shutdown', () => {
        it('→ 503 once the app is marked as shutting down', async () => {
            const { app, setShuttingDown } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            setShuttingDown(true);
            const res = await request(app).get('/api/healthz');
            expect(res.status).toBe(503);
        });
    });

    // Fase 5.2 (D7): express-session backed by connect-redis, single static
    // cookie name/path (no more per-brand mount path to hang a per-slug
    // cookie name/path off of — isolation across brands now comes from the
    // Host itself, see Fase 5.1).
    describe('session store (Fase 5.2, D7)', () => {
        it('uses a Redis-backed session store, not the in-memory default', async () => {
            const { buildSessionStore } = await import('./server.js');
            const { RedisStore } = await import('connect-redis');
            expect(buildSessionStore()).toBeInstanceOf(RedisStore);
        });

        it('is configured with the single static cookie name/path (companion.sid, Path=/)', async () => {
            const { buildSessionOptions } = await import('./server.js');
            const options = buildSessionOptions(makeValidEnv());
            expect(options.name).toBe('companion.sid');
            expect(options.cookie?.path).toBe('/');
        });

        // Security review MEDIO-2: previously `saveUninitialized: true`, which
        // made express-session persist (and Set-Cookie) a brand-new EMPTY
        // session on every anonymous request, regardless of whether anything
        // ever touched `req.session` — letting an attacker fill Redis with
        // garbage sessions 1:1 with request volume, no valid cookie or auth
        // needed. `serveUppyPage` never touches `req.session`, so a bare
        // unauthenticated `/uppy` request must no longer persist/Set-Cookie
        // a session at all.
        it('does NOT set a session cookie on a bare /uppy request that never touches req.session (MEDIO-2)', async () => {
            const { buildSessionOptions } = await import('./server.js');
            expect(buildSessionOptions(makeValidEnv()).saveUninitialized).toBe(false);

            const { app } = await createTestApp({
                brands: [makeBrand({ slug: 'edo', auth: { signInUrl: '' } })],
            });
            const res = await request(app).get('/uppy').set('Host', EDO_HOST);
            const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
            const sessionCookie = setCookie?.find((c) => c.startsWith('companion.sid='));
            expect(sessionCookie).toBeUndefined();
        });
    });

    // Fase 5.2 (D13): express-rate-limit + rate-limit-redis on /uppy and
    // /api/*, keyed by brand+user/IP (RedisStore so ≥2 replicas share state).
    describe('rate limiting (Fase 5.2, D13)', () => {
        it('GET /uppy → 429 once the configured limit is exceeded', async () => {
            const env = makeValidEnv({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
            const { app } = await createTestApp({
                env,
                brands: [makeBrand({ slug: 'edo', auth: { signInUrl: '' } })],
            });
            let last = await request(app).get('/uppy').set('Host', EDO_HOST);
            expect(last.status).not.toBe(429);
            last = await request(app).get('/uppy').set('Host', EDO_HOST);
            last = await request(app).get('/uppy').set('Host', EDO_HOST);
            expect(last.status).toBe(429);
        });

        it('GET /api/uppy/sign-s3 → 429 once the configured limit is exceeded', async () => {
            const env = makeValidEnv({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
            const { app } = await createTestApp({ env, brands: [makeBrand({ slug: 'edo' })] });
            const hit = () => request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
            await hit();
            await hit();
            const last = await hit();
            expect(last.status).toBe(429);
        });
    });

    // Security review MEDIO-1: attachUser (which triggers a whoami fetch)
    // runs as global middleware BEFORE the per-route limiter above ever
    // applies (that one is only mounted on /uppy and /api/*) — a caller with
    // arbitrary cookies could otherwise drive 1:1 load against the partner's
    // whoami through ANY brand route. `buildGlobalRateLimiter` closes that by
    // running ahead of express-session/attachUser, keyed by IP alone.
    describe('global per-IP rate limiting (MEDIO-1)', () => {
        it('GET / (falls through to the brand Companion instance) → 429 once the global limit is exceeded', async () => {
            const env = makeValidEnv({ rateLimitGlobalMax: 2, rateLimitGlobalWindowMs: 60_000 });
            const { app } = await createTestApp({ env, brands: [makeBrand({ slug: 'edo' })] });
            const hit = () => request(app).get('/').set('Host', EDO_HOST);
            await hit();
            await hit();
            const last = await hit();
            expect(last.status).toBe(429);
        });

        // BAJO-1: /api/brands previously had no rate limit of any kind.
        it('GET /api/brands → 429 once the global limit is exceeded (BAJO-1)', async () => {
            const env = makeValidEnv({ rateLimitGlobalMax: 2, rateLimitGlobalWindowMs: 60_000 });
            const { app } = await createTestApp({ env, brands: [makeBrand({ slug: 'edo' })] });
            const hit = () => request(app).get('/api/brands');
            await hit();
            await hit();
            const last = await hit();
            expect(last.status).toBe(429);
        });

        it('GET /api/healthz is exempt from the global limit (orchestrator polls it continuously)', async () => {
            const env = makeValidEnv({ rateLimitGlobalMax: 2, rateLimitGlobalWindowMs: 60_000 });
            const { app } = await createTestApp({ env, brands: [makeBrand({ slug: 'edo' })] });
            let last = { status: 0 };
            for (let i = 0; i < 5; i++) {
                last = await request(app).get('/api/healthz');
            }
            expect(last.status).toBe(200);
        });

        it('GET /api/readyz is exempt from the global limit (orchestrator polls it continuously)', async () => {
            const env = makeValidEnv({ rateLimitGlobalMax: 2, rateLimitGlobalWindowMs: 60_000 });
            const { app } = await createTestApp({ env, brands: [makeBrand({ slug: 'edo' })] });
            let last = { status: 0 };
            for (let i = 0; i < 5; i++) {
                last = await request(app).get('/api/readyz');
            }
            expect(last.status).toBe(200);
        });
    });

    // Fase 5.2: helmet CSP with a per-request nonce — uppy.html's inline
    // <script type="module"> (Fase 5.4) needs 'nonce-<x>' since 'self' alone
    // does not cover it, and 'unsafe-inline' would defeat the CSP entirely.
    describe('CSP nonce (Fase 5.2)', () => {
        it('sets script-src with a nonce plus the pinned CDN origins', async () => {
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app).get('/api/healthz');
            const csp = res.headers['content-security-policy'];
            expect(csp).toBeDefined();
            expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
            expect(csp).toContain('https://releases.transloadit.com');
            expect(csp).toContain('https://cdnjs.cloudflare.com');
        });

        it('uses a fresh nonce on every request', async () => {
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res1 = await request(app).get('/api/healthz');
            const res2 = await request(app).get('/api/healthz');
            const nonceOf = (csp: string | undefined) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp ?? '')?.[1];
            const nonce1 = nonceOf(res1.headers['content-security-policy']);
            const nonce2 = nonceOf(res2.headers['content-security-policy']);
            expect(nonce1).toBeTruthy();
            expect(nonce2).toBeTruthy();
            expect(nonce1).not.toBe(nonce2);
        });
    });

    // Security review MEDIO-3: helmet's un-derived defaults would block the
    // direct-to-S3 upload (connect-src falls back to 'self'), the designer
    // <iframe> embed of /uppy (frame-ancestors falls back to 'self'), and the
    // Google Picker. The CSP header is now derived per-request from the
    // resolved brand (core/csp.ts) — resolved from the Host header, so it
    // applies even before req.brand is attached by the later middleware.
    describe('CSP per-brand directives (MEDIO-3)', () => {
        it('connect-src includes the brand S3 bucket host', async () => {
            const { app } = await createTestApp({
                brands: [makeBrand({
                    slug: 'edo',
                    s3: { bucket: 'entourage-uploads', region: 'us-east-1' },
                })],
            });
            const res = await request(app).get('/uppy').set('Host', EDO_HOST);
            const csp = res.headers['content-security-policy'];
            expect(csp).toMatch(/connect-src[^;]*https:\/\/entourage-uploads\.s3\.us-east-1\.amazonaws\.com/);
        });

        it("frame-ancestors includes the brand's designer domain(s)", async () => {
            const { app } = await createTestApp({
                brands: [makeBrand({
                    slug: 'edo',
                    domains: ['linkdesigner.entourageyearbooks.com'],
                })],
            });
            const res = await request(app).get('/uppy').set('Host', EDO_HOST);
            const csp = res.headers['content-security-policy'];
            expect(csp).toMatch(/frame-ancestors[^;]*https:\/\/linkdesigner\.entourageyearbooks\.com/);
        });

        it('img-src allows blob: (Uppy thumbnail previews)', async () => {
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app).get('/uppy').set('Host', EDO_HOST);
            const csp = res.headers['content-security-policy'];
            expect(csp).toMatch(/img-src[^;]*blob:/);
        });

        it('falls back to the safe minimal defaults for a request that resolves no brand', async () => {
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app).get('/api/healthz');
            const csp = res.headers['content-security-policy'];
            expect(csp).toMatch(/connect-src 'self'/);
            expect(csp).toMatch(/frame-ancestors 'self'/);
        });
    });
});
