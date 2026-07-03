import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createTestApp } from './test-utils/http.js';
import { makeBrand, makeBrandWithoutAuth } from './test-utils/fixtures.js';
import { makeValidEnv } from './test-utils/env-fixtures.js';

// Readiness (Task 1.3) checks Redis via `getRedis().ping()` — swap in
// ioredis-mock so those requests never touch the network.
vi.mock('ioredis', async () => {
    const { default: RedisMock } = await import('ioredis-mock');
    return { default: RedisMock, Redis: RedisMock };
});

const s3Mock = mockClient(S3Client);

describe('server integration', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
        s3Mock.reset();
        s3Mock.on(HeadBucketCommand).resolves({});
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('GET /api/healthz → 200 with status:ok', async () => {
        const { app } = await createTestApp();
        const res = await request(app).get('/api/healthz');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('GET /api/brands without key → returns basic info only', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({ id: 'test', displayName: 'Test' })],
        });
        const res = await request(app).get('/api/brands');
        expect(res.status).toBe(200);
        expect(res.body.detailedView).toBe(false);
        expect(res.body.brands).toEqual([{ id: 'test', displayName: 'Test' }]);
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
                id: 'test',
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

    it('GET /test/uppy without session cookie → 302 to loginUrl with redirect param', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({
                id: 'test',
                public: {
                    backendUrl: 'https://app.test.example.com',
                    uploadUrl: 'https://app.test.example.com/upload',
                    foldersUrl: undefined,
                    loginUrl: 'https://app.test.example.com/login',
                },
            })],
        });
        const res = await request(app).get('/test/uppy');
        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/^https:\/\/app\.test\.example\.com\/login\?redirect=/);
    });

    it('GET /test/uppy without session cookie + no loginUrl → 401 static page', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({
                id: 'test',
                public: {
                    backendUrl: 'https://app.test.example.com',
                    uploadUrl: 'https://app.test.example.com/upload',
                    foldersUrl: undefined,
                    loginUrl: undefined,
                },
            })],
        });
        const res = await request(app).get('/test/uppy');
        expect(res.status).toBe(401);
        expect(res.text).toContain('Session Expired');
    });

    it('GET /test/uppy with valid cookie + auth ok → 200 HTML with no-store cache', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'u123' }),
        });
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .get('/test/uppy')
            .set('Cookie', 'session=tok');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.text).toContain('id="brandSlug"');
    });

    it('strip middleware removes /default/ prefix on non-default brand routes before companion sees the URL', async () => {
        // The non-default-brand chain has a middleware that strips an unwanted
        // "/default/" segment from incoming OAuth callback URLs (a quirk of how
        // Companion derives redirect URIs). We assert the strip actually
        // happened by inspecting the URL the mocked companion router observed.
        const def = makeBrand({ id: 'default' });
        const acme = makeBrand({ id: 'acme' });
        const { app } = await createTestApp({ brands: [def, acme] });
        const res = await request(app).get('/acme/default/oauth/google/callback');
        expect(res.status).toBe(200);
        // Companion mounted on /acme; Express strips that prefix from req.url.
        // The strip middleware then removes the `/default` prefix, so the URL
        // companion finally sees should be the post-strip path.
        expect(res.body.url).toBe('/oauth/google/callback');
    });

    it('strip middleware leaves URL untouched when path does not start with /default/', async () => {
        const def = makeBrand({ id: 'default' });
        const acme = makeBrand({ id: 'acme' });
        const { app } = await createTestApp({ brands: [def, acme] });
        const res = await request(app).get('/acme/oauth/google/callback');
        expect(res.status).toBe(200);
        expect(res.body.url).toBe('/oauth/google/callback');
    });

    it('strip middleware does NOT register on the default brand', async () => {
        // The default brand's chain has no strip middleware (the /default/
        // segment problem only happens for *non-default* brands when companion
        // mistakenly uses the default brand id in OAuth state). So a path like
        // /default/default/foo must reach companion with /default/foo intact —
        // the strip must NOT fire.
        const def = makeBrand({ id: 'default' });
        const { app } = await createTestApp({ brands: [def] });
        const res = await request(app).get('/default/default/oauth/google/callback');
        expect(res.status).toBe(200);
        expect(res.body.url).toBe('/default/oauth/google/callback');
    });

    it('OPTIONS /test/api/uppy/sign-s3 with valid origin → 204 with CORS headers', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({ id: 'test', rootDomain: 'test.example.com' })],
        });
        const res = await request(app)
            .options('/test/api/uppy/sign-s3')
            .set('Origin', 'http://app.test.example.com');
        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
        expect(res.headers['access-control-allow-origin']).toBe('http://app.test.example.com');
    });

    it('GET /test/uppy returns 403 when brand has no auth.url', async () => {
        const { app } = await createTestApp({
            brands: [makeBrandWithoutAuth({ id: 'test' })],
        });
        const res = await request(app).get('/test/uppy');
        expect(res.status).toBe(403);
        expect(res.text).toContain('Authentication Required');
    });

    describe('GET /api/readyz', () => {
        it('→ 200 when Redis PING and S3 HeadBucket both succeed', async () => {
            const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
            const res = await request(app).get('/api/readyz');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ok');
        });

        it('→ 503 when the S3 HeadBucket check fails', async () => {
            s3Mock.on(HeadBucketCommand).rejects(new Error('bucket unreachable'));
            const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
            const res = await request(app).get('/api/readyz');
            expect(res.status).toBe(503);
            expect(res.body.s3).toBe(false);
        });

        it('→ 503 when the S3 HeadBucket check times out', async () => {
            s3Mock.on(HeadBucketCommand).callsFake(() => new Promise(() => {
                // Never resolves — exercises the readyz S3 check's own short timeout.
            }));
            const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
            const res = await request(app).get('/api/readyz');
            expect(res.status).toBe(503);
            expect(res.body.s3).toBe(false);
        }, 10_000);

        it('→ 503 when the app is marked as shutting down', async () => {
            const { app, setShuttingDown } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
            setShuttingDown(true);
            const res = await request(app).get('/api/readyz');
            expect(res.status).toBe(503);
        });
    });

    describe('GET /api/healthz during shutdown', () => {
        it('→ 503 once the app is marked as shutting down', async () => {
            const { app, setShuttingDown } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
            setShuttingDown(true);
            const res = await request(app).get('/api/healthz');
            expect(res.status).toBe(503);
        });
    });
});
