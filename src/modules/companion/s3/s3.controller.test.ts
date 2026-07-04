import { describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, CreateMultipartUploadCommand } from '@aws-sdk/client-s3';
import { parseDeclaredLength, createMultipartUpload } from './s3.controller.js';
import { makeAppRequest, makeBrand, makeUser } from '../../../test-utils/fixtures.js';

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
