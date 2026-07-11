import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    S3Client,
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Response } from 'express';
import {
    parseDeclaredLength,
    parseFolderId,
    createMultipartUpload,
    completeMultipartUpload,
} from './s3.controller.js';
import { postIngest, type IngestResult, type IngestUpload } from '../ingest/ingest.client.js';
import { stashUploadMeta, readUploadMeta } from '../ingest/upload-meta.store.js';
import { makeAppRequest, makeBrand, makeUser } from '../../../test-utils/fixtures.js';

// s3.controller -> upload-meta.store -> lib/redis.js eagerly reads `env` from
// config/index.js at import time (deriveEnv() throws without a real
// COMPANION_SECRET) — mirrors the same fix server.integration.test.ts/http.ts
// apply, so the create/complete Redis round-trip below runs against a real
// in-memory client instead of a genuine network connection or a boot-time throw.
// The env object is inlined (not imported) because vi.mock factories are
// hoisted above every import statement in the file.
vi.mock('ioredis', async () => {
    const { default: RedisMock } = await import('ioredis-mock');
    return { default: RedisMock, Redis: RedisMock };
});
vi.mock('../../../config/index.js', () => ({
    env: {
        port: 3020,
        host: '0.0.0.0',
        protocol: 'http',
        publicHost: 'localhost:3020',
        secret: 'test-secret-value-1234567890',
        healthCheckKey: undefined,
        redisUrl: 'redis://localhost:6379',
        filePath: '/tmp/',
        rateLimitWindowMs: 60_000,
        rateLimitMax: 300,
        rateLimitGlobalWindowMs: 60_000,
        rateLimitGlobalMax: 600,
        secretsSource: 'env',
    },
}));

// The ingest S2S call itself is unit-tested in ingest/ingest.client.test.ts —
// here it's a pure boundary mock so completeMultipartUpload's own branching
// (HeadObject enforcement, response shape, no-delete) is exercised in isolation.
vi.mock('../ingest/ingest.client.js', () => ({
    postIngest: vi.fn(),
}));

const mockedPostIngest = vi.mocked(postIngest);

const makeRes = () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { json, status } as unknown as Response;
    return { res, json, status };
};

const INGEST_URL = 'https://api.test.example.com/api/internal/media/ingest';
const TOKEN_ENV = 'TEST_INGEST_TOKEN';

const makeIngestBrand: typeof makeBrand = (overrides = {}) =>
    makeBrand({
        slug: 'abe',
        limits: { maxUploadBytes: 10_000_000, allowedContentTypes: ['image/jpeg', 'image/png'] },
        ingest: { url: INGEST_URL, tokenEnv: TOKEN_ENV },
        ...overrides,
    });

const VALID_PARTS = [{ ETag: '"abc"', PartNumber: 1 }];

const okIngestResult = (uploads: IngestUpload[]): IngestResult => ({ ok: true, uploads });

// S3 raises this when a multipart uploadId is already consumed — the shape a
// legitimate client retry after a lost complete response hits. Matches the real
// SDK fingerprint (`name` + 404 `$metadata`) that isNoSuchUpload keys on,
// without depending on the SDK's @internal NoSuchUpload constructor.
const noSuchUploadError = (): Error => {
    const err = new Error('The specified multipart upload does not exist.');
    err.name = 'NoSuchUpload';
    (err as Error & { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
    return err;
};

// Copilot (PR #7) flagged that parseDeclaredLength accepted any finite number,
// including negatives/fractions, which then slipped past the `> maxUploadBytes`
// limit check. A client-declared Content-Length must be a positive integer;
// anything else is treated as "not declared" (undefined) so the check stays
// consistent.
describe('parseDeclaredLength', () => {
    it('parses a positive integer byte count', () => {
        expect(parseDeclaredLength('123')).toBe(123);
        expect(parseDeclaredLength(456)).toBe(456);
    });

    it('treats malformed byte counts as undefined (negative, fractional, zero, non-numeric, non-finite)', () => {
        for (const raw of ['-1', '1.5', '0', '-0', 'abc', 'NaN', 'Infinity', '1e999', ' ']) {
            expect(parseDeclaredLength(raw)).toBeUndefined();
        }
    });

    it('treats absent values as undefined', () => {
        expect(parseDeclaredLength(undefined)).toBeUndefined();
        expect(parseDeclaredLength(null)).toBeUndefined();
        expect(parseDeclaredLength('')).toBeUndefined();
    });
});

describe('createMultipartUpload — cifrado en reposo (Q6)', () => {
    it('crea el multipart con ServerSideEncryption AES256', async () => {
        const s3mock = mockClient(S3Client);
        s3mock.on(CreateMultipartUploadCommand).resolves({ Key: 'k', UploadId: 'u1' });

        const req = makeAppRequest({
            brand: makeBrand({ slug: 'edo', assets: { s3Prefix: '' } }),
            user: makeUser({ id: '1004' }),
            body: { filename: 'f.jpg', type: 'image/jpeg' },
            method: 'POST',
        });

        const json = vi.fn();
        const status = vi.fn(() => ({ json }));
        const res = { json, status } as never;

        await createMultipartUpload(req, res, (() => {}) as never);

        const calls = s3mock.commandCalls(CreateMultipartUploadCommand);
        expect(calls.length).toBe(1);
        expect(calls[0].args[0].input.ServerSideEncryption).toBe('AES256');
        s3mock.restore();
    });
});

describe('parseFolderId', () => {
    it('parses a positive integer folder id', () => {
        expect(parseFolderId('5')).toBe(5);
        expect(parseFolderId(7)).toBe(7);
    });

    it('treats malformed folder ids as null (negative, fractional, zero, non-numeric)', () => {
        for (const raw of ['-1', '1.5', '0', '-0', 'abc', 'NaN']) {
            expect(parseFolderId(raw)).toBeNull();
        }
    });

    it('treats absent values as null', () => {
        expect(parseFolderId(undefined)).toBeNull();
        expect(parseFolderId(null)).toBeNull();
        expect(parseFolderId('')).toBeNull();
    });
});

describe('createMultipartUpload — declared-size / MIME reject at create (P1-C-PROTOCOL Step 1)', () => {
    let s3mock: ReturnType<typeof mockClient>;

    beforeEach(() => {
        s3mock = mockClient(S3Client);
    });

    afterEach(() => {
        s3mock.restore();
    });

    it('rejects an over-declared size before ever calling S3 (client-declared, not yet authoritative)', async () => {
        const brand = makeBrand({ limits: { maxUploadBytes: 1000 } });
        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            method: 'POST',
            body: { filename: 'f.jpg', type: 'image/jpeg', size: '5000' },
        });
        const { res, json, status } = makeRes();

        await createMultipartUpload(req, res, (() => {}) as never);

        expect(status).toHaveBeenCalledWith(400);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Content-Length') }));
        expect(s3mock.commandCalls(CreateMultipartUploadCommand).length).toBe(0);
    });

    it('rejects a disallowed Content-Type before ever calling S3', async () => {
        const brand = makeBrand({ limits: { maxUploadBytes: 1_000_000, allowedContentTypes: ['image/jpeg', 'image/png'] } });
        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            method: 'POST',
            body: { filename: 'f.exe', type: 'application/x-msdownload', size: '100' },
        });
        const { res, json, status } = makeRes();

        await createMultipartUpload(req, res, (() => {}) as never);

        expect(status).toHaveBeenCalledWith(400);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Content-Type') }));
        expect(s3mock.commandCalls(CreateMultipartUploadCommand).length).toBe(0);
    });

    it('accepts a tiny in-limit file and stashes folder/size/thumbnail meta in Redis, keyed by uploadId', async () => {
        const brand = makeBrand({ slug: 'abe', limits: { maxUploadBytes: 10_000_000 } });
        s3mock.on(CreateMultipartUploadCommand).resolves({ Key: 'k1', UploadId: 'upload-stash-1' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            method: 'POST',
            body: { filename: 'tiny.jpg', type: 'image/jpeg', size: '2048', folderId: '9' },
        });
        const { res, json } = makeRes();

        await createMultipartUpload(req, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({ key: 'k1', uploadId: 'upload-stash-1' });
        const meta = await readUploadMeta('abe', 'upload-stash-1');
        expect(meta).toEqual({
            filename: 'tiny.jpg',
            mimetype: 'image/jpeg',
            declaredSize: 2048,
            folderId: 9,
            userId: 'u1',
            isThumbnail: false,
        });
    });

    it('marks the stash isThumbnail:true only when the client declares isThumbnail:"true"', async () => {
        const brand = makeBrand({ slug: 'abe', limits: { maxUploadBytes: 10_000_000 } });
        s3mock.on(CreateMultipartUploadCommand).resolves({ Key: 'k2', UploadId: 'upload-stash-2' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            method: 'POST',
            body: { filename: 'thumb_tiny.jpg', type: 'image/jpeg', size: '512', isThumbnail: 'true' },
        });
        await createMultipartUpload(req, makeRes().res, (() => {}) as never);

        const meta = await readUploadMeta('abe', 'upload-stash-2');
        expect(meta?.isThumbnail).toBe(true);
        expect(meta?.folderId).toBeNull();
    });

    // Regression: the create body is form-urlencoded on the wire, so a legacy
    // client that sent a `metadata` object serialized it via String(value) to
    // the literal "[object Object]". The server then received `metadata` as
    // that STRING, and buildS3Key's `metadata.name = ...` mutation threw a
    // TypeError on the string primitive -> caught -> 500 on every real create.
    // Prior create tests OMIT `metadata`, so they never exercised this path.
    it('does not 500 on the real client create body (stringified metadata) and builds the key from filename', async () => {
        const brand = makeBrand({ slug: 'edo', assets: { s3Prefix: '' }, limits: { maxUploadBytes: 10_000_000 } });
        s3mock.on(CreateMultipartUploadCommand).resolves({ Key: 'k-real', UploadId: 'upload-real-1' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            method: 'POST',
            body: { filename: 'photo.jpg', type: 'image/jpeg', size: '2048', metadata: '[object Object]' },
        });
        const { res, json, status } = makeRes();

        await createMultipartUpload(req, res, (() => {}) as never);

        expect(status).not.toHaveBeenCalled(); // no 500 / no error status
        expect(json).toHaveBeenCalledWith({ key: 'k-real', uploadId: 'upload-real-1' });

        const calls = s3mock.commandCalls(CreateMultipartUploadCommand);
        expect(calls.length).toBe(1);
        const s3Key = calls[0].args[0].input.Key as string;
        expect(s3Key.startsWith('original/u1/')).toBe(true);
        expect(s3Key.endsWith('/photo.jpg')).toBe(true);
    });
});

describe('completeMultipartUpload — HeadObject enforcement + inline ingest (P1-C-PROTOCOL Steps 3-4)', () => {
    let s3mock: ReturnType<typeof mockClient>;

    beforeEach(() => {
        s3mock = mockClient(S3Client);
        mockedPostIngest.mockReset();
    });

    afterEach(() => {
        s3mock.restore();
        vi.unstubAllEnvs();
    });

    it('end-to-end create -> complete happy path: ingest called with the resolved slug + trimmed token; response carries uploads unchanged', async () => {
        const brand = makeIngestBrand();
        vi.stubEnv(TOKEN_ENV, '  secret-abc  ');
        s3mock.on(CreateMultipartUploadCommand).resolves({ Key: 'original/u1/f.jpg', UploadId: 'upload-1' });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.jpg' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/jpeg' });
        mockedPostIngest.mockResolvedValue(
            okIngestResult([{ id: 1, url: 'https://cdn/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg' }]),
        );

        const createReq = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            method: 'POST',
            body: { filename: 'f.jpg', type: 'image/jpeg', size: '2048' },
        });
        await createMultipartUpload(createReq, makeRes().res, (() => {}) as never);

        const completeReq = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-1' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json } = makeRes();
        await completeMultipartUpload(completeReq, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({
            location: 'https://bucket/f.jpg',
            ingested: true,
            uploads: [{ id: 1, url: 'https://cdn/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg' }],
            ingestConfigured: true,
        });
        expect(mockedPostIngest).toHaveBeenCalledTimes(1);
        const call = mockedPostIngest.mock.calls[0][0];
        expect(call.token).toBe('secret-abc');
        expect(call.brandSlug).toBe('abe');
        expect(call.userId).toBe('u1');
        expect(call.url.href).toBe(INGEST_URL);
        expect(call.files).toEqual([
            { key: 'original/u1/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg', fileSize: 2048, source: 'local' },
        ]);
    });

    it('forwards folderId to ingest only when the stashed meta has one', async () => {
        const brand = makeIngestBrand();
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        await stashUploadMeta(brand.slug, 'upload-folder', {
            filename: 'f.jpg', mimetype: 'image/jpeg', declaredSize: 2048, folderId: 42, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.jpg' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/jpeg' });
        mockedPostIngest.mockResolvedValue(
            okIngestResult([{ id: 2, url: 'https://cdn/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg' }]),
        );

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-folder' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        await completeMultipartUpload(req, makeRes().res, (() => {}) as never);

        expect(mockedPostIngest.mock.calls[0][0].files).toEqual([
            { key: 'original/u1/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg', fileSize: 2048, folderId: 42, source: 'local' },
        ]);
    });

    it('HeadObject over-limit (authoritative, not client-declared) -> ingested:false, rejected:"over-limit", NO ingest call, NO delete', async () => {
        const brand = makeIngestBrand({ limits: { maxUploadBytes: 1000, allowedContentTypes: ['image/jpeg'] } });
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        await stashUploadMeta(brand.slug, 'upload-2', {
            filename: 'f.jpg', mimetype: 'image/jpeg', declaredSize: 500, folderId: null, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.jpg' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 999_999, ContentType: 'image/jpeg' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-2' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({ location: 'https://bucket/f.jpg', ingested: false, rejected: 'over-limit', ingestConfigured: true });
        expect(mockedPostIngest).not.toHaveBeenCalled();
        expect(s3mock.commandCalls(DeleteObjectCommand).length).toBe(0);
    });

    it('HeadObject MIME not allowed -> ingested:false, rejected:"mime-not-allowed", NO ingest call, NO delete', async () => {
        const brand = makeIngestBrand({ limits: { maxUploadBytes: 10_000_000, allowedContentTypes: ['image/jpeg'] } });
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        await stashUploadMeta(brand.slug, 'upload-mime', {
            filename: 'f.bin', mimetype: 'image/jpeg', declaredSize: 500, folderId: null, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.bin' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 500, ContentType: 'application/x-msdownload' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-mime' },
            query: { key: 'original/u1/f.bin' },
            body: { parts: VALID_PARTS },
        });
        const { res, json } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({ location: 'https://bucket/f.bin', ingested: false, rejected: 'mime-not-allowed', ingestConfigured: true });
        expect(mockedPostIngest).not.toHaveBeenCalled();
        expect(s3mock.commandCalls(DeleteObjectCommand).length).toBe(0);
    });

    it('direct-API abuse: a falsified small declared size at create does not bypass the authoritative HeadObject check at complete', async () => {
        const brand = makeIngestBrand({ limits: { maxUploadBytes: 1_000_000, allowedContentTypes: ['image/jpeg'] } });
        s3mock.on(CreateMultipartUploadCommand).resolves({ Key: 'k', UploadId: 'upload-abuse' });
        const createReq = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            method: 'POST',
            body: { filename: 'f.jpg', type: 'image/jpeg', size: '100' },
        });
        await createMultipartUpload(createReq, makeRes().res, (() => {}) as never);

        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.jpg' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 50_000_000, ContentType: 'image/jpeg' });

        const completeReq = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-abuse' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json } = makeRes();
        await completeMultipartUpload(completeReq, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({ location: 'https://bucket/f.jpg', ingested: false, rejected: 'over-limit', ingestConfigured: true });
        expect(mockedPostIngest).not.toHaveBeenCalled();
        expect(s3mock.commandCalls(DeleteObjectCommand).length).toBe(0);
    });

    it('ingest 5xx -> still 200 {ingested:false}, object left intact (no delete), no rejected reason (accepted residual)', async () => {
        const brand = makeIngestBrand();
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        await stashUploadMeta(brand.slug, 'upload-3', {
            filename: 'f.jpg', mimetype: 'image/jpeg', declaredSize: 2048, folderId: null, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.jpg' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/jpeg' });
        mockedPostIngest.mockResolvedValue({ ok: false, reason: 'status-500' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-3' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json, status } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(status).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith({ location: 'https://bucket/f.jpg', ingested: false, ingestConfigured: true });
        expect(s3mock.commandCalls(DeleteObjectCommand).length).toBe(0);
    });

    it('thumbnail short-circuit: no HeadObject, no ingest call, ingested:false without a rejected reason', async () => {
        const brand = makeIngestBrand();
        await stashUploadMeta(brand.slug, 'upload-thumb', {
            filename: 'thumb_f.jpg', mimetype: 'image/jpeg', declaredSize: 100, folderId: null, userId: 'u1', isThumbnail: true,
        });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/thumb_f.jpg' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-thumb' },
            query: { key: 'original/u1/thumb_f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({ location: 'https://bucket/thumb_f.jpg', ingested: false, ingestConfigured: true });
        expect(s3mock.commandCalls(HeadObjectCommand).length).toBe(0);
        expect(mockedPostIngest).not.toHaveBeenCalled();
    });

    it('a brand with no ingest config (e.g. edo) completes with ingested:false and no ingest call — not an orphan', async () => {
        const brand = makeBrand({ slug: 'edo', limits: { maxUploadBytes: 10_000_000 } });
        await stashUploadMeta(brand.slug, 'upload-noingest', {
            filename: 'f.jpg', mimetype: 'image/jpeg', declaredSize: 2048, folderId: null, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.jpg' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/jpeg' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-noingest' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({ location: 'https://bucket/f.jpg', ingested: false, ingestConfigured: false });
        expect(mockedPostIngest).not.toHaveBeenCalled();
    });

    it('an ingest target failing the SSRF allowlist gate -> no ingest call, ingested:false', async () => {
        const brand = makeIngestBrand({ ingest: { url: 'https://evil.example.com/ingest', tokenEnv: TOKEN_ENV } });
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        await stashUploadMeta(brand.slug, 'upload-target', {
            filename: 'f.jpg', mimetype: 'image/jpeg', declaredSize: 2048, folderId: null, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.jpg' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/jpeg' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-target' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({ location: 'https://bucket/f.jpg', ingested: false, ingestConfigured: true });
        expect(mockedPostIngest).not.toHaveBeenCalled();
    });

    it('a misconfigured ingest token (env var unset) -> no ingest call, ingested:false', async () => {
        const brand = makeIngestBrand();
        vi.stubEnv(TOKEN_ENV, undefined);
        await stashUploadMeta(brand.slug, 'upload-token', {
            filename: 'f.jpg', mimetype: 'image/jpeg', declaredSize: 2048, folderId: null, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://bucket/f.jpg' });
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/jpeg' });

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-token' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(json).toHaveBeenCalledWith({ location: 'https://bucket/f.jpg', ingested: false, ingestConfigured: true });
        expect(mockedPostIngest).not.toHaveBeenCalled();
    });

    // Idempotency gap: a prior complete succeeded but its response was lost, so
    // the client retries. S3 now returns NoSuchUpload (uploadId consumed). The
    // endpoint must NOT 500-loop — it falls through to HeadObject, which
    // confirms the object and lets ingest run idempotently. `location` is
    // undefined on this path (never reconstructed).
    it('NoSuchUpload retry + object still present -> NO 500, falls through, ingest called, 200 {ingested:true}', async () => {
        const brand = makeIngestBrand();
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        await stashUploadMeta(brand.slug, 'upload-retry-ok', {
            filename: 'f.jpg', mimetype: 'image/jpeg', declaredSize: 2048, folderId: null, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).rejects(noSuchUploadError());
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/jpeg' });
        mockedPostIngest.mockResolvedValue(
            okIngestResult([{ id: 9, url: 'https://cdn/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg' }]),
        );

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-retry-ok' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json, status } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(status).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith({
            location: undefined,
            ingested: true,
            uploads: [{ id: 9, url: 'https://cdn/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg' }],
            ingestConfigured: true,
        });
        expect(mockedPostIngest).toHaveBeenCalledTimes(1);
    });

    it('NoSuchUpload retry + object absent (HeadObject throws) -> NO 500, 200 {ingested:false}, no ingest call', async () => {
        const brand = makeIngestBrand();
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        await stashUploadMeta(brand.slug, 'upload-retry-gone', {
            filename: 'f.jpg', mimetype: 'image/jpeg', declaredSize: 2048, folderId: null, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand).rejects(noSuchUploadError());
        s3mock.on(HeadObjectCommand).rejects(new Error('NotFound'));

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-retry-gone' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json, status } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(status).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith({ location: undefined, ingested: false });
        expect(mockedPostIngest).not.toHaveBeenCalled();
    });

    it('a GENERIC complete failure (not NoSuchUpload) still 500s — retry is legitimate, unchanged', async () => {
        const brand = makeIngestBrand();
        s3mock.on(CompleteMultipartUploadCommand).rejects(new Error('transient network error'));

        const req = makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-generic-fail' },
            query: { key: 'original/u1/f.jpg' },
            body: { parts: VALID_PARTS },
        });
        const { res, json, status } = makeRes();
        await completeMultipartUpload(req, res, (() => {}) as never);

        expect(status).toHaveBeenCalledWith(500);
        expect(json).toHaveBeenCalledWith({ error: 'Error completing multipart' });
        expect(s3mock.commandCalls(HeadObjectCommand).length).toBe(0);
        expect(mockedPostIngest).not.toHaveBeenCalled();
    });

    // C2 regression: the post-complete block used to delete the stash on read,
    // so a lost-response retry (NoSuchUpload fall-through) re-entered with a
    // null stash — the thumbnail-skip was bypassed and the preview JPEG was
    // ingested as a real library asset (and folder/filename attribution was
    // lost for real files). The stash now survives, bounded by its TTL.
    it('thumbnail double-complete (lost first response) never ingests and keeps the stash readable', async () => {
        const brand = makeIngestBrand();
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        await stashUploadMeta(brand.slug, 'upload-thumb-retry', {
            filename: 'thumb_f.jpg', mimetype: 'image/jpeg', declaredSize: 100, folderId: null, userId: 'u1', isThumbnail: true,
        });
        s3mock.on(CompleteMultipartUploadCommand)
            .resolvesOnce({ Location: 'https://bucket/thumb_f.jpg' })
            .rejects(noSuchUploadError());

        const makeReq = () => makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-thumb-retry' },
            query: { key: 'original/u1/thumb_f.jpg' },
            body: { parts: VALID_PARTS },
        });

        const first = makeRes();
        await completeMultipartUpload(makeReq(), first.res, (() => {}) as never);
        expect(first.json).toHaveBeenCalledWith({ location: 'https://bucket/thumb_f.jpg', ingested: false, ingestConfigured: true });

        // Stash must still be readable after the first complete — not deleted.
        expect(await readUploadMeta(brand.slug, 'upload-thumb-retry')).not.toBeNull();

        const second = makeRes();
        await completeMultipartUpload(makeReq(), second.res, (() => {}) as never);
        expect(second.json).toHaveBeenCalledWith({ location: undefined, ingested: false, ingestConfigured: true });

        expect(mockedPostIngest).not.toHaveBeenCalled();
        expect(s3mock.commandCalls(HeadObjectCommand).length).toBe(0);
    });

    it('real-file NoSuchUpload retry re-sends the SAME folderId/filename to ingest (meta not lost)', async () => {
        const brand = makeIngestBrand();
        vi.stubEnv(TOKEN_ENV, 'secret-abc');
        // filename intentionally differs from the key basename: with the old
        // delete-on-read bug, the retry would fall back to the key basename
        // and drop folderId, so this catches both losses.
        await stashUploadMeta(brand.slug, 'upload-real-retry', {
            filename: 'my-photo.jpg', mimetype: 'image/jpeg', declaredSize: 2048, folderId: 77, userId: 'u1', isThumbnail: false,
        });
        s3mock.on(CompleteMultipartUploadCommand)
            .resolvesOnce({ Location: 'https://bucket/abc123.jpg' })
            .rejects(noSuchUploadError());
        s3mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'image/jpeg' });
        mockedPostIngest.mockResolvedValue(
            okIngestResult([{ id: 5, url: 'https://cdn/abc123.jpg', filename: 'my-photo.jpg', mimetype: 'image/jpeg' }]),
        );

        const makeReq = () => makeAppRequest({
            brand,
            user: makeUser({ id: 'u1' }),
            params: { uploadId: 'upload-real-retry' },
            query: { key: 'original/u1/abc123.jpg' },
            body: { parts: VALID_PARTS },
        });

        const first = makeRes();
        await completeMultipartUpload(makeReq(), first.res, (() => {}) as never);

        const second = makeRes();
        await completeMultipartUpload(makeReq(), second.res, (() => {}) as never);

        const expectedFiles = [
            { key: 'original/u1/abc123.jpg', filename: 'my-photo.jpg', mimetype: 'image/jpeg', fileSize: 2048, folderId: 77, source: 'local' },
        ];
        expect(mockedPostIngest).toHaveBeenCalledTimes(2);
        expect(mockedPostIngest.mock.calls[0][0].files).toEqual(expectedFiles);
        expect(mockedPostIngest.mock.calls[1][0].files).toEqual(expectedFiles);
    });
});
