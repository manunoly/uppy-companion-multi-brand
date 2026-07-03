import type { Brand } from '../brand/brand.types.js';
import type { AuthResult } from './auth.types.js';
import type { AppRequest } from '../../core/types/express.js';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

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
 * Extracts the authentication token from a request.
 *
 * Order: `Authorization: Bearer …` header > brand-specific cookie.
 *
 * Query-string tokens are NOT honored anywhere. Tokens in URL params leak
 * into proxy/CDN access logs, browser history, and Referer headers (OWASP
 * ASVS V8.3.1). The brand session cookie at `Domain=.<rootDomain>`, set by
 * the brand backend at login, is the canonical credential. The Authorization
 * header path remains valid for server-to-server callers.
 */
export const extractToken = (req: AppRequest, brand: Brand): string | null => {
    const cookies = req.cookies as Record<string, string> | undefined;

    const authHeader = req.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    const cookieToken = cookies?.[brand.auth.cookieName];
    if (cookieToken) {
        return cookieToken;
    }

    return null;
};

/**
 * Authenticates a token against the brand's auth URL
 * 
 * Flow:
 * 1. If brand has no auth.url, authentication is disabled (returns authenticated)
 * 2. Calls brand.auth.url with token in brand cookie header
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

    try {
        const response = await fetch(brand.auth.url, {
            method: 'GET',
            headers: {
                'Cookie': `${brand.auth.cookieName}=${token}`,
            },
            signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
            const json: unknown = await response.json();
            const parsed = userSchema.safeParse(json);

            return {
                authenticated: true,
                user: parsed.success ? parsed.data : null,
            };
        }

        return { authenticated: false, user: null };

    } catch (error) {
        logger.error({ err: error, brand: brand.id }, '[auth] Failed to verify user');
        return { authenticated: false, user: null };
    }
};
