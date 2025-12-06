import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../core/types/express.js';
import type { BrandRegistry } from './brand.types.js';
import { resolveBrand } from './brand.service.js';

/**
 * Creates a middleware that resolves the brand from URL params
 */
export const createBrandMiddleware = (registry: BrandRegistry) => {
    return (req: AppRequest, res: Response, next: NextFunction): void => {
        // Try to get brand from URL params first
        const brandParam = req.params.brand;

        // Then try query param
        const brandQuery = req.query.brand;

        // Then try header
        const brandHeader = req.get('x-brand');

        const identifier = brandParam ??
            (typeof brandQuery === 'string' ? brandQuery : null) ??
            brandHeader;

        if (identifier) {
            const brand = resolveBrand(registry, identifier);
            if (brand) {
                req.brand = brand;
                next();
                return;
            }

            // Brand specified but not found
            res.status(404).json({ error: `Unknown brand "${identifier}"` });
            return;
        }

        // No brand specified, use default
        if (registry.defaultBrand) {
            req.brand = registry.defaultBrand;
        }

        next();
    };
};

/**
 * Middleware that requires a brand to be resolved
 */
export const requireBrand = (req: AppRequest, res: Response, next: NextFunction): void => {
    if (!req.brand) {
        res.status(400).json({ error: 'Brand not resolved' });
        return;
    }
    next();
};
