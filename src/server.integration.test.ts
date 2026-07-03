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

    it('GET /edo/uppy without a session → 302 to auth.signInUrl with redirect param', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({
                slug: 'edo',
                auth: { signInUrl: 'https://app.test.example.com/login' },
            })],
        });
        const res = await request(app).get('/edo/uppy');
        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/^https:\/\/app\.test\.example\.com\/login\?redirect=/);
    });

    it('GET /edo/uppy without a session + no signInUrl → 401 static page', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({
                slug: 'edo',
                auth: { signInUrl: '' },
            })],
        });
        const res = await request(app).get('/edo/uppy');
        expect(res.status).toBe(401);
        expect(res.text).toContain('Session Expired');
    });

    // NOTE: the "valid cookie -> 200 HTML" happy path cannot be exercised
    // right now — `attachUser` is an interim fail-closed no-op (Task 2.7 →
    // Fase 3, see modules/auth/auth.middleware.ts) that never populates
    // req.user, so /uppy always falls through to the redirect/401 branch
    // above regardless of the cookie sent. Restored once Fase 3 wires up the
    // real session-resolver.
    it.skip('GET /edo/uppy with a valid session → 200 HTML with no-store cache', async () => {
        // TODO(Fase 3): restaurar con session-resolver
    });

    it('OPTIONS /edo/api/uppy/sign-s3 with valid origin → 204 with CORS headers', async () => {
        const { app } = await createTestApp({
            brands: [makeBrand({ slug: 'edo' })],
        });
        const res = await request(app)
            .options('/edo/api/uppy/sign-s3')
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
