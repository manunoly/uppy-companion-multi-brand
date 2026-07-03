import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../core/types/express.js';
import { resolveSession } from './session-resolver.js';
import { logger } from '../../lib/logger.js';
import { setUserId } from '../../lib/logger.js';

/**
 * Populates `req.user` from the brand's session cookie via `resolveSession`
 * (Fase 3 — replaces the interim fail-closed shim from Task 2.7). Optional:
 * never rejects the request itself, even when the session can't be resolved.
 *   - `authenticated` -> `req.user` populated + the user id recorded on the
 *     active log context (`setUserId`, lib/logger.ts's AsyncLocalStorage).
 *   - `unauthenticated`/`misconfigured` -> `req.user` stays `undefined`.
 *   - `unavailable` (partner whoami down / breaker open / timeout) -> `req.user`
 *     stays `undefined` too, but does NOT throw — this middleware degrades
 *     gracefully; `requireAuth` is what turns "no user" into a hard failure
 *     for endpoints that actually need one, with the right status code.
 */
export const attachUser = async (
    req: AppRequest,
    _res: Response,
    next: NextFunction,
): Promise<void> => {
    const brand = req.brand;
    if (!brand) {
        next();
        return;
    }

    const result = await resolveSession(brand, req.headers.cookie);
    if (result.status === 'authenticated') {
        req.user = result.user;
        setUserId(result.user.id);
    } else {
        if (result.status === 'unavailable') {
            logger.warn(
                { brand: brand.slug, reason: result.reason },
                '[auth] session resolution unavailable; continuing without a user',
            );
        }
        req.user = undefined;
    }
    next();
};

/**
 * Guards endpoints that MUST have an authenticated identity. If `req.user` is
 * already populated (typically by `attachUser` running earlier in the same
 * request's middleware chain — see server.ts's per-brand mount order), this
 * is a pure pass-through with no extra work. Otherwise it resolves the
 * session itself, so it also works when mounted standalone.
 *
 * Distinguishes the 3 failure reasons so callers get an actionable status:
 *   - 401 — no valid session (unauthenticated, or no brand resolved at all).
 *   - 503 — the partner's whoami is unavailable (breaker open / timeout / 5xx).
 *   - 403 — the brand's auth config itself is invalid (misconfigured).
 */
export const requireAuth = async (
    req: AppRequest,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    if (req.user) {
        next();
        return;
    }

    const brand = req.brand;
    if (!brand) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    const result = await resolveSession(brand, req.headers.cookie);
    switch (result.status) {
        case 'authenticated':
            req.user = result.user;
            setUserId(result.user.id);
            next();
            return;
        case 'unavailable':
            res.status(503).json({ error: 'Authentication service unavailable' });
            return;
        case 'misconfigured':
            res.status(403).json({ error: 'Brand authentication is misconfigured' });
            return;
        case 'unauthenticated':
            res.status(401).json({ error: 'Unauthorized' });
            return;
    }
};
