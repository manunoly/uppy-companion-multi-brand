import type { Brand } from '../brand/brand.types.js';
import type { AuthResult } from './auth.types.js';
import type { AppRequest } from '../../core/types/express.js';
import { z } from 'zod';

/**
 * Zod schema for validating user response from auth endpoint
 */
const userSchema = z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    email: z.string().email().optional(),
    name: z.string().optional(),
    roles: z.array(z.string()).optional().default([]),
});

/**
 * Extracts authentication token from request
 * Checks: Authorization header > Cookie > Query param
 */
export const extractToken = (req: AppRequest, brand: Brand): string | null => {
    // 1. Authorization header: Bearer xxx
    const authHeader = req.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    // 2. Brand-specific cookie
    const cookies = req.cookies as Record<string, string> | undefined;
    const cookieToken = cookies?.[brand.authCookieName];
    if (cookieToken) {
        return cookieToken;
    }

    // 3. Query param (for redirect flows)
    const queryToken = req.query.bearerToken;
    if (typeof queryToken === 'string') {
        return queryToken;
    }

    return null;
};

/**
 * Authenticates a token against the brand's auth URL
 * 
 * Flow:
 * 1. If brand has no authUrl, authentication is disabled (returns authenticated)
 * 2. Calls brand.authUrl with token in Authorization header
 * 3. If response is 200, user is authenticated
 * 4. Any other response = not authenticated
 */
export const authenticate = async (
    token: string,
    brand: Brand
): Promise<AuthResult> => {
    // If brand has no auth URL, authentication is disabled
    if (!brand.authUrl) {
        return { authenticated: true, user: null };
    }

    try {
        const response = await fetch(brand.authUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(5000),
        });

        // ✅ Response 200 = authenticated
        if (response.ok) {
            const json: unknown = await response.json();
            const parsed = userSchema.safeParse(json);

            return {
                authenticated: true,
                user: parsed.success ? parsed.data : null,
            };
        }

        // ❌ Any other status = not authenticated
        return { authenticated: false, user: null };

    } catch (error) {
        console.error(`[auth] Failed to verify user for brand "${brand.id}":`, error);
        return { authenticated: false, user: null };
    }
};
