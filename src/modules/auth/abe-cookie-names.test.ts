import { describe, it, expect } from 'vitest';
import { abeCookieNameCandidates, abeCookieNamesFor, betterAuthCookieNames } from './abe-cookie-names.js';

describe('betterAuthCookieNames', () => {
    it('prefixes with __Secure- when secure', () => {
        expect(betterAuthCookieNames(true)).toEqual({
            sessionToken: '__Secure-better-auth.session_token',
            sessionData: '__Secure-better-auth.session_data',
        });
    });

    it('omits the prefix when not secure', () => {
        expect(betterAuthCookieNames(false)).toEqual({
            sessionToken: 'better-auth.session_token',
            sessionData: 'better-auth.session_data',
        });
    });
});

describe('abeCookieNamesFor', () => {
    it('derives secure from the issuer protocol, not from the environment', () => {
        expect(abeCookieNamesFor('https://auth.abeduls.com').sessionToken).toBe('__Secure-better-auth.session_token');
        expect(abeCookieNamesFor('http://auth.abeduls.local').sessionToken).toBe('better-auth.session_token');
    });
});

describe('abeCookieNameCandidates', () => {
    it('always returns both namespaces, the issuer-matching one first', () => {
        const secureFirst = abeCookieNameCandidates('https://auth.abeduls.com');
        expect(secureFirst).toHaveLength(2);
        expect(secureFirst[0].sessionToken).toBe('__Secure-better-auth.session_token');
        expect(secureFirst[1].sessionToken).toBe('better-auth.session_token');

        const insecureFirst = abeCookieNameCandidates('http://auth.abeduls.local');
        expect(insecureFirst[0].sessionToken).toBe('better-auth.session_token');
        expect(insecureFirst[1].sessionToken).toBe('__Secure-better-auth.session_token');
    });

    it('returns both, secure first, when the issuer is empty', () => {
        const both = abeCookieNameCandidates('');
        expect(both).toHaveLength(2);
        expect(both[0].sessionToken).toBe('__Secure-better-auth.session_token');
    });
});
