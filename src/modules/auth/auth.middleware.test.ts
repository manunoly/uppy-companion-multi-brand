import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requireAuth, attachUser } from './auth.middleware.js';
import { makeBrand, makeBrandWithoutAuth, makeAppRequest, makeUser } from '../../test-utils/fixtures.js';
import type { Response } from 'express';

const makeRes = () => {
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    return res as unknown as Response;
};

describe('requireAuth', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('400 when brand is not resolved', async () => {
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(makeAppRequest(), res, next);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(next).not.toHaveBeenCalled();
    });

    it('403 when brand has no auth.url', async () => {
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(
            makeAppRequest({ brand: makeBrandWithoutAuth() } as never),
            res,
            next,
        );
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    it('passes through when req.user is already set', async () => {
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(
            makeAppRequest({ brand: makeBrand(), user: makeUser() } as never),
            res,
            next,
        );
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('401 when no token can be extracted', async () => {
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(makeAppRequest({ brand: makeBrand() } as never), res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'No token provided' });
    });

    it('401 when authenticate returns authenticated:false', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false });
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(
            makeAppRequest({ brand: makeBrand(), cookies: { session: 't' } } as never),
            res,
            next,
        );
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    });

    it('401 when authenticate returns authenticated:true but user:null', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ unknownField: 'no' }),
        });
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(
            makeAppRequest({ brand: makeBrand(), cookies: { session: 't' } } as never),
            res,
            next,
        );
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('next() and sets req.user when authenticate succeeds', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'uX' }),
        });
        const req = makeAppRequest({ brand: makeBrand(), cookies: { session: 't' } } as never);
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(req.user?.id).toBe('uX');
    });
});

describe('attachUser', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('next() without touching req.user when no brand', async () => {
        const req = makeAppRequest();
        const next = vi.fn();
        await attachUser(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.user).toBeUndefined();
    });

    it('next() without touching req.user when brand but no token', async () => {
        const req = makeAppRequest({ brand: makeBrand() } as never);
        const next = vi.fn();
        await attachUser(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.user).toBeUndefined();
    });

    it('sets req.user when authenticate succeeds', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'uX' }),
        });
        const req = makeAppRequest({ brand: makeBrand(), cookies: { session: 't' } } as never);
        const next = vi.fn();
        await attachUser(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.user?.id).toBe('uX');
    });

    it('next() without setting req.user when authenticate fails', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false });
        const req = makeAppRequest({ brand: makeBrand(), cookies: { session: 't' } } as never);
        const next = vi.fn();
        await attachUser(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.user).toBeUndefined();
    });
});
