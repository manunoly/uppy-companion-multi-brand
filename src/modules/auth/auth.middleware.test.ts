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

    // MEDIO-1 (security audit): attachUser must stash the FULL resolveSession
    // result on req.sessionResult — not just the `authenticated` case — so a
    // downstream requireAuth can reuse it instead of resolving the session a
    // second time.
    it.each([
        { status: 'authenticated', user: makeUser({ id: 'u1' }) } as const,
        { status: 'unauthenticated' } as const,
        { status: 'unavailable', reason: 'breaker open' } as const,
        { status: 'misconfigured', reason: 'whoamiUrl: host not allowed' } as const,
    ])('stores the full resolveSession result ($status) on req.sessionResult', async (result) => {
        resolveSessionMock.mockResolvedValue(result);
        const req = makeAppRequest({ brand: makeBrand() });
        await attachUser(req, makeRes(), vi.fn());
        expect(req.sessionResult).toEqual(result);
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

    // MEDIO-1 (security audit): when attachUser already ran for this request
    // (leaving its full result on req.sessionResult even though it didn't
    // populate req.user), requireAuth must REUSE that result instead of
    // calling resolveSession again — that double call meant every
    // /api/uppy/* and /s3 request fetched the partner's whoami twice
    // whenever the session wasn't `authenticated`.
    it.each([
        [{ status: 'unauthenticated' } as const, 401],
        [{ status: 'unavailable', reason: 'breaker open' } as const, 503],
        [{ status: 'misconfigured', reason: 'whoamiUrl: host not allowed' } as const, 403],
    ])('reuses a pre-existing req.sessionResult ($status) without calling resolveSession again', async (sessionResult, expectedStatus) => {
        const res = makeRes();
        const next = vi.fn();
        const req = makeAppRequest({ brand: makeBrand(), sessionResult } as never);
        await requireAuth(req, res, next);
        expect(res.status).toHaveBeenCalledWith(expectedStatus);
        expect(next).not.toHaveBeenCalled();
        expect(resolveSessionMock).not.toHaveBeenCalled();
    });

    it('reuses a pre-existing authenticated req.sessionResult without calling resolveSession again', async () => {
        const user = makeUser({ id: 'u42' });
        const res = makeRes();
        const next = vi.fn();
        const req = makeAppRequest({
            brand: makeBrand(),
            sessionResult: { status: 'authenticated', user },
        } as never);
        await requireAuth(req, res, next);
        expect(req.user).toEqual(user);
        expect(next).toHaveBeenCalled();
        expect(resolveSessionMock).not.toHaveBeenCalled();
    });

    it('resolves the session itself exactly once when mounted standalone (no req.sessionResult)', async () => {
        resolveSessionMock.mockResolvedValue({ status: 'unauthenticated' });
        const res = makeRes();
        const next = vi.fn();
        const req = makeAppRequest({ brand: makeBrand() });
        await requireAuth(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(resolveSessionMock).toHaveBeenCalledTimes(1);
    });
});
