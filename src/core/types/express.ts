// Custom Request type with Brand and User extensions
import type { Request as ExpressRequest } from 'express';
import type { Brand, BrandUser } from '../../modules/brand/brand.types.js';

/**
 * Extended Request type with brand and user properties.
 *
 * `user` is `BrandUser` (abeduls3-aligned canonical identity), populated by
 * `attachUser` (modules/auth). During the interim fail-closed shim (Task 2.7
 * → Fase 3) `attachUser` never populates it, so it stays `undefined` until
 * Fase 3 wires up the real session-resolver.
 */
export interface AppRequest extends ExpressRequest {
    brand?: Brand;
    user?: BrandUser;
}
