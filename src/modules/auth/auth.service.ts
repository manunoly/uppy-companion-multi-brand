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
    // DEBUG: Log all cookies received
    const cookies = req.cookies as Record<string, string> | undefined;
    console.log(`[auth:extractToken] Brand: ${brand.id}`);
    console.log(`[auth:extractToken] Cookie name expected: "${brand.auth.cookieName}"`);
    console.log(`[auth:extractToken] All cookies received:`, JSON.stringify(cookies));
    console.log(`[auth:extractToken] Raw cookie header:`, req.get('cookie'));

    // 1. Authorization header: Bearer xxx
    const authHeader = req.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
        console.log(`[auth:extractToken] Found token in Authorization header`);
        return authHeader.slice(7);
    }

    // 2. Brand-specific cookie
    const cookieToken = cookies?.[brand.auth.cookieName];
    if (cookieToken) {
        console.log(`[auth:extractToken] Found token in cookie: ${cookieToken.slice(0, 20)}...`);
        return cookieToken;
    }

    // 3. Query param (for redirect flows)
    const queryToken = req.query.bearerToken;
    if (typeof queryToken === 'string') {
        console.log(`[auth:extractToken] Found token in query param`);
        return queryToken;
    }

    console.log(`[auth:extractToken] ❌ No token found!`);
    return null;
};

/**
 * Authenticates a token against the brand's auth URL
 * 
 * Flow:
 * 1. If brand has no auth.url, authentication is disabled (returns authenticated)
 * 2. Calls brand.auth.url with token in Authorization header
 * 3. If response is 200, user is authenticated
 * 4. Any other response = not authenticated
 */
export const authenticate = async (
    token: string,
    brand: Brand
): Promise<AuthResult> => {
    // If brand has no auth URL, authentication is disabled
    if (!brand.auth.url) {
        return { authenticated: true, user: null };
    }

    console.log(`[auth:authenticate] Calling auth URL: ${brand.auth.url}`);
    console.log(`[auth:authenticate] Token (first 20 chars): ${token.slice(0, 20)}...`);

    // Parse URL to debug DNS resolution
    const authUrl = new URL(brand.auth.url);
    console.log(`[auth:authenticate] Host: ${authUrl.host}, Protocol: ${authUrl.protocol}`);

    try {
        const response = await fetch(brand.auth.url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                // Forward session cookie for cookie-based auth endpoints
                'Cookie': `${brand.auth.cookieName}=${token}`,
            },
            // Note: credentials is NOT valid in Node.js fetch, only in browsers
            signal: AbortSignal.timeout(10000), // Increased timeout for internal networking
        });

        console.log(`[auth:authenticate] Response status: ${response.status}`);

        // ✅ Response 200 = authenticated
        if (response.ok) {
            const json: unknown = await response.json();
            console.log(`[auth:authenticate] ✅ Authenticated! Response:`, JSON.stringify(json).slice(0, 100));
            const parsed = userSchema.safeParse(json);

            return {
                authenticated: true,
                user: parsed.success ? parsed.data : null,
            };
        }

        // ❌ Any other status = not authenticated
        const errorText = await response.text();
        console.log(`[auth:authenticate] ❌ Not authenticated. Status: ${response.status}, Body: ${errorText.slice(0, 200)}`);
        return { authenticated: false, user: null };

    } catch (error) {
        // Enhanced error logging
        const err = error as Error & { cause?: Error; code?: string };
        console.error(`[auth] Failed to verify user for brand "${brand.id}"`);
        console.error(`[auth] Error name: ${err.name}`);
        console.error(`[auth] Error message: ${err.message}`);
        console.error(`[auth] Error code: ${err.code}`);
        if (err.cause) {
            console.error(`[auth] Cause:`, err.cause);
        }
        return { authenticated: false, user: null };
    }
};
