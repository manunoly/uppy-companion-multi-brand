export type BetterAuthCookieNames = { readonly sessionToken: string; readonly sessionData: string };

export function betterAuthCookieNames(isSecure: boolean): BetterAuthCookieNames {
    const prefix = isSecure ? '__Secure-' : '';
    return {
        sessionToken: `${prefix}better-auth.session_token`,
        sessionData: `${prefix}better-auth.session_data`,
    };
}

const isSecureIssuer = (issuer: string): boolean => issuer.startsWith('https://');

export function abeCookieNamesFor(issuer: string): BetterAuthCookieNames {
    return betterAuthCookieNames(isSecureIssuer(issuer));
}

// Both candidates, always: one guessed namespace can lock abe out or miss a mid-migration jar.
export function abeCookieNameCandidates(issuer: string): readonly BetterAuthCookieNames[] {
    const secure = betterAuthCookieNames(true);
    const insecure = betterAuthCookieNames(false);
    if (!issuer) return [secure, insecure];
    return isSecureIssuer(issuer) ? [secure, insecure] : [insecure, secure];
}
