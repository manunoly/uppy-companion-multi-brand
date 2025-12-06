import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../core/types/express.js';
import { extractToken, authenticate } from './auth.service.js';

/**
 * Middleware that requires authentication
 * Responds with 401 if not authenticated
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

    const token = extractToken(req, brand);

    if (!token) {
        res.status(401).json({ error: 'No token provided' });
        return;
    }

    const result = await authenticate(token, brand);

    if (!result.authenticated) {
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
