import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../core/types/express.js';
import { extractToken, authenticate } from './auth.service.js';

/**
 * Middleware that requires authentication.
 *
 * Order of checks:
 *   1. Brand must be resolved.
 *   2. Brand must have an auth backend configured (`brand.auth.url`). Brands
 *      without one return 403 — there is no way to validate identity, and we
 *      refuse to attribute uploads to anyone.
 *   3. If `attachUser` already populated `req.user` upstream, skip re-auth.
 *   4. Extract token, validate against the brand backend, populate `req.user`.
 */
export const requireAuth = async (
    req: AppRequest,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const brand = req.brand;

    if (!brand) {
        res.status(400).json({ error: 'Brand not resolved' });
        return;
    }

    if (!brand.auth.url) {
        res.status(403).json({ error: 'This brand does not support authenticated uploads' });
        return;
    }

    if (req.user) {
        next();
        return;
    }

    const token = extractToken(req, brand);
    if (!token) {
        res.status(401).json({ error: 'No token provided' });
        return;
    }

    const result = await authenticate(token, brand);
    if (!result.authenticated || !result.user) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
    }

    req.user = result.user;
    next();
};

/**
 * Middleware that optionally attaches user to request
 * Does not fail if no token or invalid token
 */
export const attachUser = async (
    req: AppRequest,
    _res: Response,
    next: NextFunction
): Promise<void> => {
    const brand = req.brand;

    if (brand) {
        const token = extractToken(req, brand);
        if (token) {
            const result = await authenticate(token, brand);
            if (result.authenticated) {
                req.user = result.user;
            }
        }
    }

    next();
};
