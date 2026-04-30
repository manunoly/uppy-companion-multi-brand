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
    const brandA = makeBrand({ id: 'a' });
    const brandB = makeBrand({ id: 'b' });
    const registry = makeBrandRegistry([brandA, brandB]);
    const middleware = createBrandMiddleware(registry);

    it('resolves brand from req.params.brand', () => {
        const req = makeAppRequest({ params: { brand: 'b' } } as never);
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand?.id).toBe('b');
        expect(next).toHaveBeenCalled();
    });

    it('resolves brand from req.query.brand when params absent', () => {
        const req = makeAppRequest({ query: { brand: 'b' } } as never);
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand?.id).toBe('b');
    });

    it('resolves brand from x-brand header when params/query absent', () => {
        const headers: Record<string, string> = { 'x-brand': 'b' };
        const req = makeAppRequest({
            get: (name: string) => headers[name.toLowerCase()],
        } as never);
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand?.id).toBe('b');
    });

    it('falls back to default brand when no identifier provided', () => {
        const req = makeAppRequest();
        const next = vi.fn();
        middleware(req, makeRes(), next);
        expect(req.brand?.id).toBe('a');
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
