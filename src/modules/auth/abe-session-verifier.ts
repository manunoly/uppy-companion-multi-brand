import type { Brand, BrandUser } from '../brand/brand.contract.js';
import { PARTNER_ID_PATTERN, resolveValidatedAuthOrigin } from '../brand/identity.js';
import { logger } from '../../lib/logger.js';
import { createJwksCache, verifySessionCookie } from '../../vendor/auth-verify/index.js';
import { abeCookieNamesFor } from './abe-cookie-names.js';

export type AbeSessionResult =
    | { status: 'valid'; user: BrandUser; emailVerified: boolean }
    | { status: 'miss'; cause: 'absent' | 'expired' | 'poisoned' | 'unavailable' | 'credential-mismatch' };

export interface AbeSessionVerifier {
    verify(cookieHeader: string | undefined | null): Promise<AbeSessionResult>;
}

export function createAbeSessionVerifier(brand: Brand): AbeSessionVerifier | null {
    const origin = resolveValidatedAuthOrigin(brand);
    // getAbeSessionVerifier is the only caller and it validates first, so this is unreachable in
    // production; it stays as the guard a direct test caller relies on. The warning lives there.
    if (!origin.ok) return null;

    const jwks = createJwksCache({ authOrigin: origin.issuer });
    const { sessionToken: sessionTokenName, sessionData: sessionDataName } = abeCookieNamesFor(origin.issuer);

    return {
        async verify(cookieHeader) {
            if (!cookieHeader) return { status: 'miss', cause: 'absent' };

            let headers: Headers;
            try {
                headers = new Headers({ cookie: cookieHeader });
            } catch {
                return { status: 'miss', cause: 'poisoned' };
            }

            const result = await verifySessionCookie(headers, {
                jwks,
                issuer: origin.issuer,
                sessionDataName,
                sessionTokenName,
            });
            if (result.status !== 'valid') return { status: 'miss', cause: result.status };

            // The same shape guards normalizeBrandUser applies to a whoami response, so a locally
            // verified user is never less validated than a remotely verified one.
            const { id, email, name, image } = result.user;
            if (!PARTNER_ID_PATTERN.test(id) || !email.includes('@')) {
                return { status: 'miss', cause: 'poisoned' };
            }

            return {
                status: 'valid',
                user: {
                    id,
                    email,
                    displayName: typeof name === 'string' ? name : null,
                    imageUrl: typeof image === 'string' ? image : null,
                },
                emailVerified: result.user.emailVerified === true,
            };
        },
    };
}

const verifiers = new Map<string, AbeSessionVerifier>();

// createJwksCache keeps the key set in a closure, so one instance per (brand, issuer) must
// outlive the request. Keyed on the resolved issuer so an override change still takes effect.
const originWarnedFor = new Set<string>();

export function getAbeSessionVerifier(brand: Brand): AbeSessionVerifier | null {
    const origin = resolveValidatedAuthOrigin(brand);
    if (!origin.ok) {
        // Once per brand+reason: a rejected origin turns local verification off for good, and
        // relaying every request to the whoami looks exactly like working, only slower.
        const warned = `${brand.slug}|${origin.reason}`;
        if (!originWarnedFor.has(warned)) {
            originWarnedFor.add(warned);
            logger.warn({ slug: brand.slug, reason: origin.reason }, '[auth] abe local verification is OFF');
        }
        return null;
    }

    const key = `${brand.slug}|${origin.issuer}`;
    const cached = verifiers.get(key);
    if (cached) return cached;

    const created = createAbeSessionVerifier(brand);
    if (created) verifiers.set(key, created);
    return created;
}
