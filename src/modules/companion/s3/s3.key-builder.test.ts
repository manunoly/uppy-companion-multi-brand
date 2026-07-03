import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildS3Key, buildUserKeyPrefix } from './s3.key-builder.js';
import { makeBrand, makeAppRequest, makeUser } from '../../../test-utils/fixtures.js';

describe('buildUserKeyPrefix', () => {
    it('produces {s3Prefix}original/{id}/ with an empty s3Prefix (edo, SA1)', () => {
        const brand = makeBrand({ slug: 'edo', assets: { s3Prefix: '' } });
        const user = makeUser({ id: '1004' });
        expect(buildUserKeyPrefix(brand, user)).toBe('original/1004/');
    });

    it('prepends brand.assets.s3Prefix when it is non-empty', () => {
        const brand = makeBrand({ slug: 'abe', assets: { s3Prefix: 'brands/abe/' } });
        const user = makeUser({ id: 'cuidXYZ' });
        expect(buildUserKeyPrefix(brand, user)).toBe('brands/abe/original/cuidXYZ/');
    });

    it('throws when user.id is missing', () => {
        const brand = makeBrand();
        const user = makeUser({ id: undefined as unknown as string });
        expect(() => buildUserKeyPrefix(brand, user)).toThrow(/id/);
    });

    it('never uses edoId — only the canonical id', () => {
        const brand = makeBrand({ slug: 'edo' });
        const user = makeUser({ id: '1004', edoId: 854569 });
        const prefix = buildUserKeyPrefix(brand, user);
        expect(prefix).toBe('original/1004/');
        expect(prefix).not.toContain('854569');
    });
});

describe('buildS3Key', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-29T10:30:45.123Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses the canonical id and NOT edoId, simple path without UPID (SA1/D6)', () => {
        const req = makeAppRequest({
            brand: makeBrand({ slug: 'edo', assets: { s3Prefix: '' } }),
            user: makeUser({ id: '1004', edoId: 854569 }),
        } as never);
        const key = buildS3Key({ req, filename: 'f.png' });
        expect(key).toMatch(/^original\/1004\/\d{4}\/\d{1,2}\/\d{1,2}\/\d+\/f\.png$/);
        expect(key).not.toContain('854569'); // edoId must never leak into the key
        expect(key).not.toContain('UPID'); // no legacy UPID_{orderId} segment
        expect(key).not.toMatch(/^edo\//); // no {brand}/ prefix — isolation is by bucket
    });

    it('throws when req.user is not populated', () => {
        const req = makeAppRequest({ brand: makeBrand() } as never);
        expect(() => buildS3Key({ req, filename: 'x.jpg' })).toThrow(/userId required/);
    });

    it('does NOT fall back to a default user when req.user is null', () => {
        const req = makeAppRequest({ brand: makeBrand(), user: undefined } as never);
        expect(() => buildS3Key({ req, filename: 'x.jpg' })).toThrow();
    });

    it('throws when req.brand is not populated', () => {
        const req = makeAppRequest({ brand: undefined, user: makeUser({ id: 'u1' }) } as never);
        expect(() => buildS3Key({ req, filename: 'x.jpg' })).toThrow(/brand/);
    });

    it('sanitizes filename — strips characters outside [a-zA-Z0-9._-]', () => {
        const req = makeAppRequest({
            brand: makeBrand(),
            user: makeUser({ id: 'u' }),
        } as never);
        const key = buildS3Key({ req, filename: 'my photo (1)!.jpg' });
        expect(key.split('/').pop()).toBe('myphoto1.jpg');
    });

    it('is a single function independent of brand: same id/prefix ⇒ same relative path regardless of slug', () => {
        const reqEdo = makeAppRequest({
            brand: makeBrand({ slug: 'edo', assets: { s3Prefix: '' } }),
            user: makeUser({ id: 'u123' }),
        } as never);
        const reqAbe = makeAppRequest({
            brand: makeBrand({ slug: 'abe', assets: { s3Prefix: '' } }),
            user: makeUser({ id: 'u123' }),
        } as never);
        const keyEdo = buildS3Key({ req: reqEdo, filename: 'x.jpg' });
        const keyAbe = buildS3Key({ req: reqAbe, filename: 'x.jpg' });
        expect(keyEdo).toBe(keyAbe);
    });

    it('prepends brand.assets.s3Prefix when configured', () => {
        const req = makeAppRequest({
            brand: makeBrand({ slug: 'abe', assets: { s3Prefix: 'brands/abe/' } }),
            user: makeUser({ id: 'cuidXYZ' }),
        } as never);
        const key = buildS3Key({ req, filename: 'x.jpg' });
        expect(key.startsWith('brands/abe/original/cuidXYZ/')).toBe(true);
    });

    it('falls back to "untitled" when no filename or metadata.name', () => {
        const req = makeAppRequest({
            brand: makeBrand(),
            user: makeUser({ id: 'u' }),
        } as never);
        const key = buildS3Key({ req });
        expect(key.endsWith('/untitled')).toBe(true);
    });

    it('uses metadata.name as fallback when filename is absent', () => {
        const req = makeAppRequest({
            brand: makeBrand(),
            user: makeUser({ id: 'u' }),
        } as never);
        const key = buildS3Key({ req, metadata: { name: 'fromMeta.jpg' } });
        expect(key.endsWith('/fromMeta.jpg')).toBe(true);
    });
});
