import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    S3Client,
    CreateMultipartUploadCommand,
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    ListPartsCommand,
} from '@aws-sdk/client-s3';
import { createTestApp } from '../../test-utils/http.js';
import { makeBrand } from '../../test-utils/fixtures.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: vi.fn().mockResolvedValue('https://signed.example.com/url'),
}));

const s3Mock = mockClient(S3Client);

describe('api.routes integration (cookie auth + S3 mock)', () => {
    beforeEach(() => {
        s3Mock.reset();
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

    it('GET /test/api/uppy/sign-s3 without cookie → 401', async () => {
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .get('/test/api/uppy/sign-s3')
            .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(401);
    });

    it('GET /test/api/uppy/sign-s3 with cookie → 200 with signed URL', async () => {
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .get('/test/api/uppy/sign-s3')
            .set('Cookie', 'session=tok')
            .query({ filename: 'a.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(200);
        expect(res.body.url).toBe('https://signed.example.com/url');
        expect(res.body.method).toBe('PUT');
    });

    it('POST /test/api/uppy/s3/multipart → returns key + uploadId', async () => {
        setupAuthOk();
        s3Mock.on(CreateMultipartUploadCommand).resolves({ Key: 'kk', UploadId: 'up123' });
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .post('/test/api/uppy/s3/multipart')
            .set('Cookie', 'session=tok')
            .send({ filename: 'a.jpg', type: 'image/jpeg' });
        expect(res.status).toBe(200);
        expect(res.body.uploadId).toBe('up123');
        expect(res.body.key).toBe('kk');
    });

    it('POST /test/api/uppy/s3/multipart with non-string filename → 400', async () => {
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .post('/test/api/uppy/s3/multipart')
            .set('Cookie', 'session=tok')
            .send({ filename: 123, type: 'image/jpeg' });
        expect(res.status).toBe(400);
    });

    it('GET /test/api/uppy/s3/multipart/:uploadId/:partNumber rejects part number out of range', async () => {
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .get('/test/api/uppy/s3/multipart/u/0')
            .set('Cookie', 'session=tok')
            .query({ key: 'test/original/u123/x.jpg' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/part number/);
    });

    it('GET /test/api/uppy/s3/multipart/:uploadId/:partNumber rejects key not owned by user', async () => {
        setupAuthOk();
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .get('/test/api/uppy/s3/multipart/up1/1')
            .set('Cookie', 'session=tok')
            .query({ key: 'test/original/EVIL/x.jpg' });
        expect(res.status).toBe(403);
    });

    it('GET /test/api/uppy/s3/multipart/:uploadId (list parts) returns array', async () => {
        setupAuthOk();
        s3Mock.on(ListPartsCommand).resolves({
            Parts: [{ PartNumber: 1, ETag: '"abc"' }],
            IsTruncated: false,
        });
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .get('/test/api/uppy/s3/multipart/up1')
            .set('Cookie', 'session=tok')
            .query({ key: 'test/original/u123/x.jpg' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ PartNumber: 1, ETag: '"abc"' }]);
    });

    it('POST /test/api/uppy/s3/multipart/:uploadId/complete sends CompleteMultipartUploadCommand', async () => {
        setupAuthOk();
        s3Mock.on(CompleteMultipartUploadCommand).resolves({ Location: 'https://s3/ok' });
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .post('/test/api/uppy/s3/multipart/up1/complete')
            .set('Cookie', 'session=tok')
            .query({ key: 'test/original/u123/x.jpg' })
            .send({ parts: [{ PartNumber: 1, ETag: '"abc"' }] });
        expect(res.status).toBe(200);
        expect(res.body.location).toBe('https://s3/ok');
        expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
    });

    it('DELETE /test/api/uppy/s3/multipart/:uploadId sends AbortMultipartUploadCommand', async () => {
        setupAuthOk();
        s3Mock.on(AbortMultipartUploadCommand).resolves({});
        const { app } = await createTestApp({ brands: [makeBrand({ id: 'test' })] });
        const res = await request(app)
            .delete('/test/api/uppy/s3/multipart/up1')
            .set('Cookie', 'session=tok')
            .query({ key: 'test/original/u123/x.jpg' });
        expect(res.status).toBe(200);
        expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
    });
});
