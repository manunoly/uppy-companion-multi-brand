import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../core/types/express.js';
import type { ResolvedBrandRegistry } from './brand.service.js';
import { isBrandSlug } from './slugs.js';
import { normalizeBrandSlug } from './brand.utils.js';

/**
 * Creates a middleware that resolves the brand from URL params/query/header.
 *
 * NOTE: per the Gotchas in CLAUDE.md, this is NOT used for the per-brand
 * mount chains in `server.ts` — those attach `req.brand` directly, since
 * `req.params.brand` is empty on a literal mount path. This middleware exists
 * for routes that take `:brand` as an explicit path/query/header parameter.
 *
 * Unlike the legacy CSV-based registry, there is no "default brand" concept
 * in the abeduls3-aligned model (D4) — brands are resolved by exact slug
 * match only. When no identifier is supplied, `req.brand` is left unset.
 */
export const createBrandMiddleware = (registry: ResolvedBrandRegistry) => {
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
            const normalized = normalizeBrandSlug(identifier);
            const brand = isBrandSlug(normalized) ? registry[normalized] : undefined;
            if (brand) {
                req.brand = brand;
                next();
                return;
            }

            // Brand specified but not found
            res.status(404).json({ error: `Unknown brand "${identifier}"` });
            return;
        }

        // No identifier supplied and no default-brand concept (D4) — leave
        // req.brand unset and let downstream middleware (e.g. requireBrand)
        // decide whether that's fatal.
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
