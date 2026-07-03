import { describe, it, expect, vi } from 'vitest';
import { requireAuth, attachUser } from './auth.middleware.js';
import { makeBrand, makeAppRequest, makeUser } from '../../test-utils/fixtures.js';
import type { Response } from 'express';

const makeRes = () => {
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    return res as unknown as Response;
};

// Interim fail-closed shim (Task 2.7 → Fase 3): the real whoami-based
// session-resolver flow (partner-whoami fetch, SSRF gate, breaker, cache)
// lands in Fase 3. Until then, `attachUser` is a no-op and `requireAuth`
// always refuses — see auth.middleware.ts's module doc comment.

describe('attachUser (interim fail-closed shim)', () => {
    it('never populates req.user when no brand is resolved', async () => {
        const req = makeAppRequest();
        const next = vi.fn();
        await attachUser(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.user).toBeUndefined();
    });

    it('never populates req.user even when a brand is resolved', async () => {
        const req = makeAppRequest({ brand: makeBrand(), cookies: { session: 'tok' } } as never);
        const next = vi.fn();
        await attachUser(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.user).toBeUndefined();
    });
});

describe('requireAuth (interim fail-closed shim)', () => {
    it('401s when nothing is resolved on the request', async () => {
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(makeAppRequest(), res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('401s even with a resolved brand + cookie', async () => {
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(
            makeAppRequest({ brand: makeBrand(), cookies: { session: 'tok' } } as never),
            res,
            next,
        );
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('401s even when req.user is already (somehow) populated — never lets a request through', async () => {
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(
            makeAppRequest({ brand: makeBrand(), user: makeUser() } as never),
            res,
            next,
        );
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });
});
