// Custom Request type with Brand and User extensions
import type { Request as ExpressRequest } from 'express';
import type { Brand } from '../../modules/brand/brand.types.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';

/**
 * Extended Request type with brand and user properties
 */
export interface AppRequest extends ExpressRequest {
    brand?: Brand;
    user?: AuthUser | null;
}
