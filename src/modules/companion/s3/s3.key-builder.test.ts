import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildS3Key, buildUserKeyPrefix } from './s3.key-builder.js';
import { makeBrand, makeAppRequest, makeUser } from '../../../test-utils/fixtures.js';

describe('buildUserKeyPrefix', () => {
    it('produces brand/original/userId/ format', () => {
        expect(buildUserKeyPrefix('acme', 'u123')).toBe('acme/original/u123/');
    });

    it('lowercases and sanitizes brand id', () => {
        expect(buildUserKeyPrefix('AcmeBrand!', 'u1')).toBe('acmebrand-/original/u1/');
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

    it('produces a key with brand/original/userId/year/month/day/timestamp/filename shape', () => {
        const req = makeAppRequest({
            brand: makeBrand({ id: 'test' }),
            user: makeUser({ id: 'u123' }),
        } as never);
        const key = buildS3Key({ req, filename: 'photo.jpg' });
        // 2026/4/29 (month is 0-indexed +1, day is 1-31)
        expect(key).toMatch(/^test\/original\/u123\/\d{4}\/\d{1,2}\/\d{1,2}\/\d+\/photo\.jpg$/);
    });

    it('throws when req.user is not populated', () => {
        const req = makeAppRequest({ brand: makeBrand() } as never);
        expect(() => buildS3Key({ req, filename: 'x.jpg' })).toThrow(
            /userId required/,
        );
    });

    it('does NOT fall back to a default user when req.user is null', () => {
        const req = makeAppRequest({ brand: makeBrand(), user: undefined } as never);
        expect(() => buildS3Key({ req, filename: 'x.jpg' })).toThrow();
    });

    it('sanitizes filename — strips characters outside [a-zA-Z0-9._-]', () => {
        const req = makeAppRequest({
            brand: makeBrand(),
            user: makeUser({ id: 'u' }),
        } as never);
        const key = buildS3Key({ req, filename: 'my photo (1)!.jpg' });
        expect(key.split('/').pop()).toBe('myphoto1.jpg');
    });

    it('uses brand.id as the prefix', () => {
        const req = makeAppRequest({
            brand: makeBrand({ id: 'acme' }),
            user: makeUser({ id: 'u123' }),
        } as never);
        const key = buildS3Key({ req, filename: 'x.jpg' });
        expect(key.startsWith('acme/original/u123/')).toBe(true);
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

    it('writes sanitized brand back to metadata.brand', () => {
        const meta: Record<string, unknown> = {};
        const req = makeAppRequest({
            brand: makeBrand({ id: 'AcmeBrand' }),
            user: makeUser({ id: 'u' }),
        } as never);
        buildS3Key({ req, filename: 'x.jpg', metadata: meta });
        expect(meta.brand).toBe('acmebrand');
    });
});
