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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: vi.fn().mockResolvedValue('https://signed.example.com/url'),
}));

const s3Mock = mockClient(S3Client);
const getSignedUrlMock = vi.mocked(getSignedUrl);

describe('api.routes integration (cookie auth + S3 mock)', () => {
    beforeEach(() => {
        s3Mock.reset();
        getSignedUrlMock.mockClear();
        getSignedUrlMock.mockResolvedValue('https://signed.example.com/url');
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const setupAuthOk = () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'u123' }),
        });
    };

    // `requireAuth` (modules/auth/auth.middleware.ts) is an interim
    // fail-closed shim (Task 2.7 → Fase 3): it ALWAYS responds 401,
    // regardless of cookie/brand state, until Fase 3 wires up the real
    // session-resolver. This is the one test in this file that still
    // reflects real behavior in the current interim state.
    it('every /edo/api/uppy/* request → 401 (interim fail-closed auth shim)', async () => {
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/edo/api/uppy/sign-s3')
            .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(401);
    });

    // The tests below all depend on requireAuth letting an authenticated
    // request through to the S3 controller — impossible until Fase 3
    // restores real session validation. Skipped with a TODO rather than
    // deleted so the AWS-contract coverage they added (bucket/key/command
    // shape assertions) is not silently lost.

    it.skip('GET /edo/api/uppy/sign-s3 with cookie → 200 with signed URL', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/edo/api/uppy/sign-s3')
            .set('Cookie', 'session=tok')
            .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(200);
        expect(res.body.url).toBe('https://signed.example.com/url');
        expect(res.body.method).toBe('PUT');
    });

    it.skip('POST /edo/api/uppy/s3/multipart → returns key + uploadId', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        s3Mock.on(CreateMultipartUploadCommand).resolves({ Key: 'kk', UploadId: 'up123' });
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .post('/edo/api/uppy/s3/multipart')
            .set('Cookie', 'session=tok')
            .send({ filename: 'a.jpg', type: 'image/jpeg' });
        expect(res.status).toBe(200);
        expect(res.body.uploadId).toBe('up123');
        expect(res.body.key).toBe('kk');
    });

    it.skip('POST /edo/api/uppy/s3/multipart with non-string filename → 400', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .post('/edo/api/uppy/s3/multipart')
            .set('Cookie', 'session=tok')
            .send({ filename: 123, type: 'image/jpeg' });
        expect(res.status).toBe(400);
    });

    it.skip('GET /edo/api/uppy/s3/multipart/:uploadId/:partNumber rejects part number out of range', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/edo/api/uppy/s3/multipart/u/0')
            .set('Cookie', 'session=tok')
            .query({ key: 'edo/original/u123/x.jpg' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/part number/);
    });

    it.skip('GET /edo/api/uppy/s3/multipart/:uploadId/:partNumber rejects key not owned by user', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/edo/api/uppy/s3/multipart/up1/1')
            .set('Cookie', 'session=tok')
            .query({ key: 'edo/original/EVIL/x.jpg' });
        expect(res.status).toBe(403);
    });

    it.skip('GET /edo/api/uppy/s3/multipart/:uploadId (list parts) returns array', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        s3Mock.on(ListPartsCommand).resolves({
            Parts: [{ PartNumber: 1, ETag: '"abc"' }],
            IsTruncated: false,
        });
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/edo/api/uppy/s3/multipart/up1')
            .set('Cookie', 'session=tok')
            .query({ key: 'edo/original/u123/x.jpg' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ PartNumber: 1, ETag: '"abc"' }]);
    });

    it.skip('POST /edo/api/uppy/s3/multipart/:uploadId/complete sends CompleteMultipartUploadCommand', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        s3Mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://s3/ok' });
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .post('/edo/api/uppy/s3/multipart/up1/complete')
            .set('Cookie', 'session=tok')
            .query({ key: 'edo/original/u123/x.jpg' })
            .send({ parts: [{ PartNumber: 1, ETag: '"abc"' }] });
        expect(res.status).toBe(200);
        expect(res.body.location).toBe('https://s3/ok');
        expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
    });

    it.skip('DELETE /edo/api/uppy/s3/multipart/:uploadId sends AbortMultipartUploadCommand', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        s3Mock.on(AbortMultipartUploadCommand).resolves({});
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .delete('/edo/api/uppy/s3/multipart/up1')
            .set('Cookie', 'session=tok')
            .query({ key: 'edo/original/u123/x.jpg' });
        expect(res.status).toBe(200);
        expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
    });

    // The four tests below were added in response to a code review pointing out
    // that the original suite asserted *responses* but not the underlying AWS
    // contract (which command is built, with which Bucket, what happens on AWS
    // failure). They protect against silent regressions where someone refactors
    // the controller to use a different command type or hard-codes a global
    // bucket instead of `brand.s3.bucket`.

    it.skip('signS3 builds a PutObjectCommand with the brand bucket and content type', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        const brand = makeBrand({
            slug: 'edo',
            s3: { bucket: 'my-brand-bucket' },
        });
        const { app } = await createTestApp({ brands: [brand] });
        const res = await request(app)
            .get('/edo/api/uppy/sign-s3')
            .set('Cookie', 'session=tok')
            .query({ filename: 'photo.jpg', contentType: 'image/png' });
        expect(res.status).toBe(200);
        expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
        const command = getSignedUrlMock.mock.calls[0][1];
        expect(command).toBeInstanceOf(PutObjectCommand);
        const cmdInput = (command as PutObjectCommand).input;
        expect(cmdInput.Bucket).toBe('my-brand-bucket');
        expect(cmdInput.ContentType).toBe('image/png');
        expect(cmdInput.Key).toMatch(/^edo\/original\/u123\/\d{4}\/\d{1,2}\/\d{1,2}\/\d+\/photo\.jpg$/);
    });

    it.skip('signPart happy path returns a signed URL and builds an UploadPartCommand with the brand bucket', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        const brand = makeBrand({
            slug: 'edo',
            s3: { bucket: 'my-brand-bucket' },
        });
        const { app } = await createTestApp({ brands: [brand] });
        const res = await request(app)
            .get('/edo/api/uppy/s3/multipart/up1/3')
            .set('Cookie', 'session=tok')
            .query({ key: 'edo/original/u123/file.bin' });
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
        expect(cmdInput.Key).toBe('edo/original/u123/file.bin');
    });

    it.skip('createMultipartUpload returns 500 with generic error when S3 throws', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        s3Mock.on(CreateMultipartUploadCommand).rejects(new Error('AccessDenied'));
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .post('/edo/api/uppy/s3/multipart')
            .set('Cookie', 'session=tok')
            .send({ filename: 'a.jpg', type: 'image/jpeg' });
        expect(res.status).toBe(500);
        // Generic message — must NOT leak the underlying AWS error string.
        expect(res.body.error).toBe('Error initiating multipart upload');
        expect(res.body.error).not.toMatch(/AccessDenied/);
    });

    it.skip('signS3 returns 500 when getSignedUrl rejects', async () => {
        // TODO(Fase 3): restaurar con session-resolver
        setupAuthOk();
        getSignedUrlMock.mockRejectedValueOnce(new Error('SignatureDoesNotMatch'));
        const { app } = await createTestApp({ brands: [makeBrand({ slug: 'edo' })] });
        const res = await request(app)
            .get('/edo/api/uppy/sign-s3')
            .set('Cookie', 'session=tok')
            .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Error signing upload');
        expect(res.body.error).not.toMatch(/SignatureDoesNotMatch/);
    });
});
