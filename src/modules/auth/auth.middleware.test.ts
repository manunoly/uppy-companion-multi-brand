import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import { attachUser, requireAuth } from './auth.middleware.js';
import { makeBrand, makeAppRequest, makeUser } from '../../test-utils/fixtures.js';
import { runWithContext, getContext } from '../../lib/logger.js';
import * as sessionResolver from './session-resolver.js';

vi.mock('./session-resolver.js', () => ({
    resolveSession: vi.fn(),
}));

const resolveSessionMock = vi.mocked(sessionResolver.resolveSession);

const makeRes = () => {
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    return res as unknown as Response;
};

describe('attachUser', () => {
    beforeEach(() => {
        resolveSessionMock.mockReset();
    });

    it('calls next without resolving a session when no brand is on the request', async () => {
        const next = vi.fn();
        const req = makeAppRequest();
        await attachUser(req, makeRes(), next);
        expect(next).toHaveBeenCalled();
        expect(req.user).toBeUndefined();
        expect(resolveSessionMock).not.toHaveBeenCalled();
    });

    it('populates req.user and records the user id in the log context on authenticated', async () => {
        const user = makeUser({ id: 'u1' });
        resolveSessionMock.mockResolvedValue({ status: 'authenticated', user });
        const req = makeAppRequest({ brand: makeBrand(), headers: { cookie: 'session=tok' } } as never);
        const next = vi.fn();

        await runWithContext({}, async () => {
            await attachUser(req, makeRes(), next);
            expect(getContext()?.userId).toBe('u1');
        });

        expect(req.user).toEqual(user);
        expect(next).toHaveBeenCalled();
    });

    it('leaves req.user undefined on unauthenticated', async () => {
        resolveSessionMock.mockResolvedValue({ status: 'unauthenticated' });
        const req = makeAppRequest({ brand: makeBrand() });
        const next = vi.fn();
        await attachUser(req, makeRes(), next);
        expect(req.user).toBeUndefined();
        expect(next).toHaveBeenCalled();
    });

    it('does not throw and leaves req.user undefined on unavailable (degrades, logs a warning)', async () => {
        resolveSessionMock.mockResolvedValue({ status: 'unavailable', reason: 'breaker open' });
        const req = makeAppRequest({ brand: makeBrand() });
        const next = vi.fn();
        await expect(attachUser(req, makeRes(), next)).resolves.toBeUndefined();
        expect(req.user).toBeUndefined();
        expect(next).toHaveBeenCalled();
    });

    it('leaves req.user undefined on misconfigured', async () => {
        resolveSessionMock.mockResolvedValue({ status: 'misconfigured', reason: 'whoamiUrl: host not allowed' });
        const req = makeAppRequest({ brand: makeBrand() });
        const next = vi.fn();
        await attachUser(req, makeRes(), next);
        expect(req.user).toBeUndefined();
        expect(next).toHaveBeenCalled();
    });
});

describe('requireAuth', () => {
    beforeEach(() => {
        resolveSessionMock.mockReset();
    });

    it('401s when no brand is resolved on the request (never calls resolveSession)', async () => {
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(makeAppRequest(), res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
        expect(resolveSessionMock).not.toHaveBeenCalled();
    });

    it('passes through immediately when req.user is already populated (no resolveSession call)', async () => {
        const res = makeRes();
        const next = vi.fn();
        const req = makeAppRequest({ brand: makeBrand(), user: makeUser() } as never);
        await requireAuth(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        expect(resolveSessionMock).not.toHaveBeenCalled();
    });

    it('401s on unauthenticated', async () => {
        resolveSessionMock.mockResolvedValue({ status: 'unauthenticated' });
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(makeAppRequest({ brand: makeBrand() }), res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('503s on unavailable', async () => {
        resolveSessionMock.mockResolvedValue({ status: 'unavailable', reason: 'breaker open' });
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(makeAppRequest({ brand: makeBrand() }), res, next);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(next).not.toHaveBeenCalled();
    });

    it('403s on misconfigured', async () => {
        resolveSessionMock.mockResolvedValue({ status: 'misconfigured', reason: 'whoamiUrl: host not allowed' });
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(makeAppRequest({ brand: makeBrand() }), res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    it('populates req.user and calls next on authenticated', async () => {
        const user = makeUser({ id: 'u9' });
        resolveSessionMock.mockResolvedValue({ status: 'authenticated', user });
        const req = makeAppRequest({ brand: makeBrand() });
        const next = vi.fn();
        await requireAuth(req, makeRes(), next);
        expect(req.user).toEqual(user);
        expect(next).toHaveBeenCalled();
    });
});
