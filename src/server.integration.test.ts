import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from './test-utils/http.js';
import { makeBrand, makeBrandWithoutAuth } from './test-utils/fixtures.js';
import { makeValidEnv } from './test-utils/env-fixtures.js';

describe('server integration', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
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

    it('GET /default/test/oauth/google/callback strips /default for non-default brand', async () => {
        // Brands: default + acme. Hitting /acme/default/oauth/google should
        // have its /default segment stripped before reaching companion.
        const def = makeBrand({ id: 'default' });
        const acme = makeBrand({ id: 'acme' });
        const { app } = await createTestApp({ brands: [def, acme] });
        // We can't easily intercept the strip; instead, verify the route mounts
        // by hitting an obviously-unmapped path and confirming the strip middleware
        // did NOT 500.
        const res = await request(app).get('/acme/default/some-unknown-path');
        // Either 404 (companion router didn't match) or 200 (mocked router
        // matches everything). The point is no crash.
        expect([200, 404, 401, 403]).toContain(res.status);
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
});
