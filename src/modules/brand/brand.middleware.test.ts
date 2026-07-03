import { describe, it, expect, vi } from 'vitest';
import { createBrandMiddleware, requireBrand } from './brand.middleware.js';
import { makeBrand, makeBrandRegistry, makeAppRequest } from '../../test-utils/fixtures.js';
import type { Response } from 'express';

const makeRes = () => {
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    return res as unknown as Response;
};

describe('createBrandMiddleware', () => {
    const brandEdo = makeBrand({ slug: 'edo' });
    const brandAbe = makeBrand({ slug: 'abe' });
    const registry = makeBrandRegistry([brandEdo, brandAbe]);
    const middleware = createBrandMiddleware(registry);

    it('resolves brand from req.params.brand', () => {
        const req = makeAppRequest({ params: { brand: 'abe' } } as never);
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand?.slug).toBe('abe');
        expect(next).toHaveBeenCalled();
    });

    it('resolves brand from req.query.brand when params absent', () => {
        const req = makeAppRequest({ query: { brand: 'abe' } } as never);
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand?.slug).toBe('abe');
    });

    it('resolves brand from x-brand header when params/query absent', () => {
        const headers: Record<string, string> = { 'x-brand': 'abe' };
        const req = makeAppRequest({
            get: (name: string) => headers[name.toLowerCase()],
        } as never);
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand?.slug).toBe('abe');
    });

    it('normalizes the identifier before lookup', () => {
        const req = makeAppRequest({ params: { brand: 'ABE' } } as never);
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand?.slug).toBe('abe');
    });

    it('does not set req.brand when no identifier is provided (no default-brand concept, D4)', () => {
        const req = makeAppRequest();
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand).toBeUndefined();
        expect(next).toHaveBeenCalled();
    });

    it('returns 404 when explicit identifier does not match a brand', () => {
        const req = makeAppRequest({ params: { brand: 'nope' } } as never);
        const res = makeRes();
        const next = vi.fn();
        middleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 404 for a syntactically-valid but unregistered slug', () => {
        // 'picaboo' is a known BrandSlug but not present in this test registry.
        const req = makeAppRequest({ params: { brand: 'picaboo' } } as never);
        const res = makeRes();
        const next = vi.fn();
        middleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(next).not.toHaveBeenCalled();
    });
});

describe('requireBrand', () => {
    it('calls next() when req.brand is set', () => {
        const req = makeAppRequest({ brand: makeBrand() } as never);
        const next = vi.fn();
        requireBrand(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('returns 400 when req.brand is missing', () => {
        const req = makeAppRequest();
        const res = makeRes();
        const next = vi.fn();
        requireBrand(req, res, next);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(next).not.toHaveBeenCalled();
    });
});
