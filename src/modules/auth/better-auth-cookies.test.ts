import { describe, it, expect } from 'vitest';
import { betterAuthCookieNames } from './abe-cookie-names.js';
import { buildBetterAuthPair, buildCredentialOnly, parseCookieEntries } from './better-auth-cookies.js';

const names = betterAuthCookieNames(false);

describe('parseCookieEntries', () => {
    it('returns every name/value pair, trimmed and URL-decoded', () => {
        expect(parseCookieEntries('a=1; b=hello%20world')).toEqual([
            ['a', '1'],
            ['b', 'hello world'],
        ]);
    });

    it('keeps the raw value when it is not valid percent-encoding', () => {
        expect(parseCookieEntries('a=100%')).toEqual([['a', '100%']]);
    });

    it('skips entries with no "="', () => {
        expect(parseCookieEntries('a=1; garbage; b=2')).toEqual([
            ['a', '1'],
            ['b', '2'],
        ]);
    });

    it('returns an empty array for an empty header', () => {
        expect(parseCookieEntries('')).toEqual([]);
    });
});

describe('buildBetterAuthPair', () => {
    it('returns null when the credential is absent', () => {
        const entries = parseCookieEntries(`${names.sessionData}=jwt`);
        expect(buildBetterAuthPair(entries, names)).toBeNull();
    });

    it('forwards the credential alone when there is no cache cookie', () => {
        const entries = parseCookieEntries(`${names.sessionToken}=tok.sig`);
        expect(buildBetterAuthPair(entries, names)).toBe(`${names.sessionToken}=tok.sig`);
    });

    it('forwards both when the cache cookie is unchunked', () => {
        const entries = parseCookieEntries(`${names.sessionToken}=tok.sig; ${names.sessionData}=jwt`);
        expect(buildBetterAuthPair(entries, names)).toBe(
            `${names.sessionToken}=tok.sig; ${names.sessionData}=jwt`,
        );
    });

    it('reassembles chunks in NUMERIC order, not lexical', () => {
        const entries = parseCookieEntries(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.10=k; ${names.sessionData}.2=c; ${names.sessionData}.1=b; ${names.sessionData}.0=a`,
        );
        expect(buildBetterAuthPair(entries, names)).toBe(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.0=a; ${names.sessionData}.1=b; ${names.sessionData}.2=c; ${names.sessionData}.10=k`,
        );
    });

    it('ignores a non-numeric suffix on the cache cookie name', () => {
        const entries = parseCookieEntries(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.x=junk; ${names.sessionData}.0=a`,
        );
        expect(buildBetterAuthPair(entries, names)).toBe(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.0=a`,
        );
    });

    it('an empty cache cookie is a deletion marker — the fresh chunks win', () => {
        const entries = parseCookieEntries(
            `${names.sessionToken}=tok.sig; ${names.sessionData}=; ${names.sessionData}.0=a; ${names.sessionData}.1=b`,
        );
        expect(buildBetterAuthPair(entries, names)).toBe(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.0=a; ${names.sessionData}.1=b`,
        );
    });

    it('an unusable cache cookie drops the CACHE, never the credential', () => {
        const entries: [string, string][] = [
            [names.sessionToken, 'tok.sig'],
            [names.sessionData, 'jwt;injected=1'],
        ];
        expect(buildBetterAuthPair(entries, names)).toBe(`${names.sessionToken}=tok.sig`);
    });

    it('one unusable chunk drops every chunk — a partial reassembly is garbage upstream', () => {
        const entries: [string, string][] = [
            [names.sessionToken, 'tok.sig'],
            [`${names.sessionData}.0`, 'a'],
            [`${names.sessionData}.1`, 'b;injected=1'],
        ];
        expect(buildBetterAuthPair(entries, names)).toBe(`${names.sessionToken}=tok.sig`);
    });

    it('returns null when the CREDENTIAL itself carries a header delimiter', () => {
        const entries: [string, string][] = [[names.sessionToken, 'tok.sig;injected=1']];
        expect(buildBetterAuthPair(entries, names)).toBeNull();
    });
});

describe('buildCredentialOnly', () => {
    it('drops the cache cookie entirely', () => {
        const entries = parseCookieEntries(`${names.sessionToken}=tok.sig; ${names.sessionData}=jwt`);
        expect(buildCredentialOnly(entries, names)).toBe(`${names.sessionToken}=tok.sig`);
    });

    it('returns null when the credential is absent', () => {
        const entries = parseCookieEntries(`${names.sessionData}=jwt`);
        expect(buildCredentialOnly(entries, names)).toBeNull();
    });
});
