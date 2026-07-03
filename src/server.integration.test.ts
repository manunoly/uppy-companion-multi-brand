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

const s3Mock = mockClient(S3Client);

// Real companionHosts entry for `edo` in the code-only base registry
// (modules/brand/registry.ts) — Host-based resolution (Fase 5.1/D4) is keyed
// against THIS registry, not against whatever `makeBrand()` fixture fields a
// test passes to `createTestApp`. `req.brand` itself still comes from the
// fixture (via the slug match), so brand-specific overrides (auth.signInUrl,
// limits, s3, etc.) still take effect.
const EDO_HOST = 'companion.stage.entourageyearbooks.com';

describe('server integration', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
        vi.stubEnv('BRAND_FORCE', '');
        s3Mock.reset();
        s3Mock.on(HeadBucketCommand).resolves({});
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
});
