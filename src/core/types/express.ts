// Custom Request type with Brand and User extensions
import type { Request as ExpressRequest } from 'express';
import type { Brand, BrandUser } from '../../modules/brand/brand.types.js';
import type { SessionResolution } from '../../modules/auth/session-resolver.js';

/**
 * Extended Request type with brand and user properties.
 *
 * `user` is `BrandUser` (abeduls3-aligned canonical identity), populated by
 * `attachUser` (modules/auth). During the interim fail-closed shim (Task 2.7
 * → Fase 3) `attachUser` never populates it, so it stays `undefined` until
 * Fase 3 wires up the real session-resolver.
 *
 * `sessionResult` (security audit MEDIO-1) caches the full `SessionResolution`
 * returned by `resolveSession` for this request — not just the `authenticated`
 * case that populates `user`. `attachUser` always sets it when a brand is
 * resolved; `requireAuth` reuses it instead of calling `resolveSession` again,
 * so a single request never fetches the brand's whoami endpoint twice. See
 * `modules/auth/auth.middleware.ts` for the full rationale.
 */
export interface AppRequest extends ExpressRequest {
    brand?: Brand;
    user?: BrandUser;
    sessionResult?: SessionResolution;
}
