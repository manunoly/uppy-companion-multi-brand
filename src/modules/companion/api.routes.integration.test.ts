import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    S3Client,
    CreateMultipartUploadCommand,
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    ListPartsCommand,
    PutObjectCommand,
    UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createTestApp } from '../../test-utils/http.js';
import { makeBrand } from '../../test-utils/fixtures.js';
import { makeValidEnv } from '../../test-utils/env-fixtures.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: vi.fn().mockResolvedValue('https://signed.example.com/url'),
}));

// `requireAuth` now resolves a real session via `resolveSession` (Fase 3),
// which reads/writes Redis (whoami cache + circuit breaker) — swap in
// `ioredis-mock` so these tests never touch the network, same pattern as
// `server.integration.test.ts`.
vi.mock('ioredis', async () => {
    const { default: RedisMock } = await import('ioredis-mock');
    return { default: RedisMock, Redis: RedisMock };
});
// `getRedis()` (lib/redis.ts) eagerly reads `env` from `config/index.js` at
// import time — mocked here (in addition to `createTestApp`'s own per-test
// mock) so `flushall()` below can import it directly from `beforeEach`,
// before `createTestApp` has run for that test.
vi.mock('../../config/index.js', () => ({
    env: makeValidEnv(),
}));
// Fase 5.2's rate limiter (mounted on /api) uses rate-limit-redis's Lua-script
// based Store — ioredis-mock doesn't execute Lua (see server.integration.test.ts
// for the full rationale). Swap in a minimal in-memory Store satisfying the
// same express-rate-limit Store contract so /api/uppy/* requests here don't
// crash on SCRIPT LOAD/EVALSHA.
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
const getSignedUrlMock = vi.mocked(getSignedUrl);

// Real companionHosts entry for `edo` (modules/brand/registry.ts) — see the
// note in server.integration.test.ts: Host-based resolution (Fase 5.1) keys
// off the code-only base registry, not the makeBrand() fixture's own fields.
const EDO_HOST = 'companion.stage.entourageyearbooks.com';

describe('api.routes integration (cookie auth + S3 mock)', () => {
    beforeEach(async () => {
        s3Mock.reset();
        getSignedUrlMock.mockClear();
        getSignedUrlMock.mockResolvedValue('https://signed.example.com/url');
        vi.stubGlobal('fetch', vi.fn());
        vi.stubEnv('BRAND_FORCE', '');
        // Every test below authenticates as the same brand+cookie pair, so
        // resolveSession's whoami cache (and the circuit breaker) would
        // otherwise carry state from one test into the next.
        const { getRedis } = await import('../../lib/redis.js');
        await getRedis().flushall();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    // A real whoami 200 response shaped for the default test brand's
    // `responseMapping` (fixtures.ts: idField/emailField/nameField/imageField
    // = id/email/name/imageUrl) — `resolveSession` forwards the `session`
    // cookie set below to this (mocked) endpoint and normalizes the result
    // into `req.user`.
    const setupAuthOk = () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
            new Response(
                JSON.stringify({ id: 'u123', email: 'test@example.com', name: 'Test User', imageUrl: null }),
                { status: 200 },
            ),
        );
    };

    it('every /api/uppy/* request without a cookie → 401', async () => {
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/api/uppy/sign-s3')
            .set('Host', EDO_HOST)
            .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(401);
    });

    it('GET /api/uppy/sign-s3 with cookie → 200 with signed URL', async () => {
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/api/uppy/sign-s3')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(200);
        expect(res.body.url).toBe('https://signed.example.com/url');
        expect(res.body.method).toBe('PUT');
    });

    it('POST /api/uppy/s3/multipart → returns key + uploadId', async () => {
        setupAuthOk();
        s3Mock.on(CreateMultipartUploadCommand).resolves({ Key: 'kk', UploadId: 'up123' });
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .post('/api/uppy/s3/multipart')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .send({ filename: 'a.jpg', type: 'image/jpeg' });
        expect(res.status).toBe(200);
        expect(res.body.uploadId).toBe('up123');
        expect(res.body.key).toBe('kk');
    });

    it('POST /api/uppy/s3/multipart with non-string filename → 400', async () => {
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .post('/api/uppy/s3/multipart')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .send({ filename: 123, type: 'image/jpeg' });
        expect(res.status).toBe(400);
    });

    it('GET /api/uppy/s3/multipart/:uploadId/:partNumber rejects part number out of range', async () => {
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/api/uppy/s3/multipart/u/0')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ key: 'original/u123/x.jpg' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/part number/);
    });

    it('GET /api/uppy/s3/multipart/:uploadId/:partNumber rejects key not owned by user', async () => {
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/api/uppy/s3/multipart/up1/1')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ key: 'original/EVIL/x.jpg' });
        expect(res.status).toBe(403);
    });

    it('GET /api/uppy/s3/multipart/:uploadId (list parts) returns array', async () => {
        setupAuthOk();
        s3Mock.on(ListPartsCommand).resolves({
            Parts: [{ PartNumber: 1, ETag: '"abc"' }],
            IsTruncated: false,
        });
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/api/uppy/s3/multipart/up1')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ key: 'original/u123/x.jpg' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ PartNumber: 1, ETag: '"abc"' }]);
    });

    it('POST /api/uppy/s3/multipart/:uploadId/complete sends CompleteMultipartUploadCommand', async () => {
        setupAuthOk();
        s3Mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://s3/ok' });
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .post('/api/uppy/s3/multipart/up1/complete')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ key: 'original/u123/x.jpg' })
            .send({ parts: [{ PartNumber: 1, ETag: '"abc"' }] });
        expect(res.status).toBe(200);
        expect(res.body.location).toBe('https://s3/ok');
        expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
    });

    it('DELETE /api/uppy/s3/multipart/:uploadId sends AbortMultipartUploadCommand', async () => {
        setupAuthOk();
        s3Mock.on(AbortMultipartUploadCommand).resolves({});
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .delete('/api/uppy/s3/multipart/up1')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ key: 'original/u123/x.jpg' });
        expect(res.status).toBe(200);
        expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
    });

    // The four tests below were added in response to a code review pointing out
    // that the original suite asserted *responses* but not the underlying AWS
    // contract (which command is built, with which Bucket, what happens on AWS
    // failure). They protect against silent regressions where someone refactors
    // the controller to use a different command type or hard-codes a global
    // bucket instead of `brand.s3.bucket`.

    it('signS3 builds a PutObjectCommand with the brand bucket and content type', async () => {
        setupAuthOk();
        const brand = makeBrand({
            slug: 'edo',
            s3: { bucket: 'my-brand-bucket' },
        });
        const { app } = await createTestApp({ brands: [brand] });
        const res = await request(app)
            .get('/api/uppy/sign-s3')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ filename: 'photo.jpg', contentType: 'image/png' });
        expect(res.status).toBe(200);
        expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
        const command = getSignedUrlMock.mock.calls[0][1];
        expect(command).toBeInstanceOf(PutObjectCommand);
        const cmdInput = (command as PutObjectCommand).input;
        expect(cmdInput.Bucket).toBe('my-brand-bucket');
        expect(cmdInput.ContentType).toBe('image/png');
        // No `{brand}/` segment (D6/SA1) — isolation is by bucket, not prefix.
        expect(cmdInput.Key).toMatch(/^original\/u123\/\d{4}\/\d{1,2}\/\d{1,2}\/\d+\/photo\.jpg$/);
    });

    it('signPart happy path returns a signed URL and builds an UploadPartCommand with the brand bucket', async () => {
        setupAuthOk();
        const brand = makeBrand({
            slug: 'edo',
            s3: { bucket: 'my-brand-bucket' },
        });
        const { app } = await createTestApp({ brands: [brand] });
        const res = await request(app)
            .get('/api/uppy/s3/multipart/up1/3')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ key: 'original/u123/file.bin' });
        expect(res.status).toBe(200);
        expect(res.body.url).toBe('https://signed.example.com/url');
        expect(res.body.expires).toBe(300);
        expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
        const command = getSignedUrlMock.mock.calls[0][1];
        expect(command).toBeInstanceOf(UploadPartCommand);
        const cmdInput = (command as UploadPartCommand).input;
        expect(cmdInput.Bucket).toBe('my-brand-bucket');
        expect(cmdInput.UploadId).toBe('up1');
        expect(cmdInput.PartNumber).toBe(3);
        expect(cmdInput.Key).toBe('original/u123/file.bin');
    });

    it('createMultipartUpload returns 500 with generic error when S3 throws', async () => {
        setupAuthOk();
        s3Mock.on(CreateMultipartUploadCommand).rejects(new Error('AccessDenied'));
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .post('/api/uppy/s3/multipart')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .send({ filename: 'a.jpg', type: 'image/jpeg' });
        expect(res.status).toBe(500);
        // Generic message — must NOT leak the underlying AWS error string.
        expect(res.body.error).toBe('Error initiating multipart upload');
        expect(res.body.error).not.toMatch(/AccessDenied/);
    });

    it('signS3 returns 500 when getSignedUrl rejects', async () => {
        setupAuthOk();
        getSignedUrlMock.mockRejectedValueOnce(new Error('SignatureDoesNotMatch'));
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/api/uppy/sign-s3')
            .set('Host', EDO_HOST)
            .set('Cookie', 'session=tok')
            .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Error signing upload');
        expect(res.body.error).not.toMatch(/SignatureDoesNotMatch/);
    });

    // D14/H13 (partial): declared size/type limits, validated before signing.
    // This is declarative only — signS3/signPart sign a PUT by query string
    // (SigV4), not a presigned POST, so S3 itself never enforces
    // `content-length-range` and a dishonest client can still send a
    // different real size to the signed URL. Real server-side enforcement
    // requires migrating to presigned POST (Fase 8, spec D14/8.5).
    describe('declared size/type limits (H13 partial)', () => {
        it('signS3 rejects a declared Content-Length above brand.limits.maxUploadBytes → 400', async () => {
            setupAuthOk();
            const brand = makeBrand({ slug: 'edo', limits: { maxUploadBytes: 1024 } });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ filename: 'a.jpg', contentType: 'image/jpeg', contentLength: '2048' });
            expect(res.status).toBe(400);
            expect(getSignedUrlMock).not.toHaveBeenCalled();
        });

        it('signS3 accepts a declared Content-Length within the brand limit → 200', async () => {
            setupAuthOk();
            const brand = makeBrand({ slug: 'edo', limits: { maxUploadBytes: 1024 } });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ filename: 'a.jpg', contentType: 'image/jpeg', contentLength: '512' });
            expect(res.status).toBe(200);
        });

        it('signS3 rejects a Content-Type outside brand.limits.allowedContentTypes → 400', async () => {
            setupAuthOk();
            const brand = makeBrand({
                slug: 'edo',
                limits: { maxUploadBytes: 50 * 1024 * 1024, allowedContentTypes: ['image/jpeg'] },
            });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ filename: 'a.png', contentType: 'image/png' });
            expect(res.status).toBe(400);
            expect(getSignedUrlMock).not.toHaveBeenCalled();
        });

        it('signS3 allows a Content-Type inside brand.limits.allowedContentTypes → 200', async () => {
            setupAuthOk();
            const brand = makeBrand({
                slug: 'edo',
                limits: { maxUploadBytes: 50 * 1024 * 1024, allowedContentTypes: ['image/jpeg'] },
            });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
            expect(res.status).toBe(200);
        });

        it('signS3 does not validate Content-Type when brand.limits.allowedContentTypes is undefined', async () => {
            setupAuthOk();
            const brand = makeBrand({ slug: 'edo', limits: { maxUploadBytes: 50 * 1024 * 1024 } });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ filename: 'a.exe', contentType: 'application/x-msdownload' });
            expect(res.status).toBe(200);
        });

        it('signPart rejects a declared Content-Length above brand.limits.maxUploadBytes → 400', async () => {
            setupAuthOk();
            const brand = makeBrand({ slug: 'edo', limits: { maxUploadBytes: 1024 } });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .get('/api/uppy/s3/multipart/up1/1')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ key: 'original/u123/x.jpg', contentLength: '2048' });
            expect(res.status).toBe(400);
            expect(getSignedUrlMock).not.toHaveBeenCalled();
        });

        it('signPart accepts a declared Content-Length within the brand limit → 200', async () => {
            setupAuthOk();
            const brand = makeBrand({ slug: 'edo', limits: { maxUploadBytes: 1024 } });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .get('/api/uppy/s3/multipart/up1/1')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ key: 'original/u123/x.jpg', contentLength: '512' });
            expect(res.status).toBe(200);
        });

        it('signS3/signPart with no declared Content-Length skip the size check (declarative-only limitation)', async () => {
            setupAuthOk();
            const brand = makeBrand({ slug: 'edo', limits: { maxUploadBytes: 1 } }); // absurdly small
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
            expect(res.status).toBe(200);
        });

        // MEDIO-2 (security audit): createMultipartUpload previously never
        // validated the client-declared `type` against
        // brand.limits.allowedContentTypes at all — only signS3/signPart did.
        it('createMultipartUpload rejects a Content-Type outside brand.limits.allowedContentTypes → 400', async () => {
            setupAuthOk();
            const brand = makeBrand({
                slug: 'edo',
                limits: { maxUploadBytes: 50 * 1024 * 1024, allowedContentTypes: ['image/jpeg'] },
            });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .post('/api/uppy/s3/multipart')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .send({ filename: 'a.png', type: 'image/png' });
            expect(res.status).toBe(400);
            expect(s3Mock.commandCalls(CreateMultipartUploadCommand)).toHaveLength(0);
        });

        it('createMultipartUpload allows a Content-Type inside brand.limits.allowedContentTypes → 200', async () => {
            setupAuthOk();
            s3Mock.on(CreateMultipartUploadCommand).resolves({ Key: 'kk', UploadId: 'up123' });
            const brand = makeBrand({
                slug: 'edo',
                limits: { maxUploadBytes: 50 * 1024 * 1024, allowedContentTypes: ['image/jpeg'] },
            });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .post('/api/uppy/s3/multipart')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .send({ filename: 'a.jpg', type: 'image/jpeg' });
            expect(res.status).toBe(200);
            expect(res.body.uploadId).toBe('up123');
        });

        it('createMultipartUpload does not validate Content-Type when brand.limits.allowedContentTypes is undefined', async () => {
            setupAuthOk();
            s3Mock.on(CreateMultipartUploadCommand).resolves({ Key: 'kk', UploadId: 'up123' });
            const brand = makeBrand({ slug: 'edo', limits: { maxUploadBytes: 50 * 1024 * 1024 } });
            const { app } = await createTestApp({ brands: [brand] });
            const res = await request(app)
                .post('/api/uppy/s3/multipart')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .send({ filename: 'a.exe', type: 'application/x-msdownload' });
            expect(res.status).toBe(200);
        });
    });

    // MEDIO-1 (security audit): attachUser (global) and requireAuth (mounted
    // on apiRouter) previously each called resolveSession independently
    // whenever the session wasn't `authenticated` — 2 whoami fetches for a
    // single inbound request. attachUser now stashes the full result on
    // req.sessionResult and requireAuth reuses it, so exactly ONE fetch call
    // should reach the partner's whoami endpoint per request, regardless of
    // outcome.
    describe('MEDIO-1: attachUser + requireAuth resolve the session at most once per request', () => {
        it('cookie rejected by whoami (401 unauthenticated) → single fetch call, endpoint responds 401', async () => {
            (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(null, { status: 401 }));
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=bad-token')
                .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
            expect(res.status).toBe(401);
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });

        it('whoami partner down (5xx, unavailable) → single fetch call, endpoint responds 503', async () => {
            (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('boom', { status: 500 }));
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
            expect(res.status).toBe(503);
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });

        it('authenticated session → single fetch call, endpoint responds 200', async () => {
            setupAuthOk();
            const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
            const res = await request(app)
                .get('/api/uppy/sign-s3')
                .set('Host', EDO_HOST)
                .set('Cookie', 'session=tok')
                .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
            expect(res.status).toBe(200);
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });
    });
});
