import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionBrandConfig } from './brand.contract.js';
import {
    buildCookieHeader,
    isWhoamiHostAllowed,
    normalizeBrandUser,
    resolveEffectiveAuth,
    resolveEffectiveSessionCookieName,
    resolveValidatedWhoamiTarget,
    validateWhoamiUrl,
} from './identity.js';
import { getBaseBrandConfig } from './registry.js';
import { logger } from '../../lib/logger.js';

const edo = getBaseBrandConfig('edo');

const ALLOWED = ['entourageyearbooks.com'];

const CAPSULE_FIXTURE: CompanionBrandConfig = {
    ...getBaseBrandConfig('abe'),
    auth: {
        kind: 'capsule',
        signInUrl: 'https://abe.example.com/login',
        whoamiUrl: 'https://api.abe.example.com/whoami',
        whoamiAllowedHosts: ['abe.example.com'],
        sessionCookieName: 'abes_session',
        responseMapping: { idField: 'id', emailField: 'email', nameField: 'displayName', imageField: 'imageUrl' },
    },
};

beforeEach(() => {
    vi.stubEnv('EDO_BRAND_OVERRIDE', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

// --- isWhoamiHostAllowed (suffix-match) ---

describe('isWhoamiHostAllowed', () => {
    it('accepts the apex and any subdomain (suffix-match)', () => {
        expect(isWhoamiHostAllowed('entourageyearbooks.com', ALLOWED)).toBe(true);
        expect(isWhoamiHostAllowed('edonext-app.entourageyearbooks.com', ALLOWED)).toBe(true);
        expect(isWhoamiHostAllowed('edonext-app.stage.entourageyearbooks.com', ALLOWED)).toBe(true);
    });

    it('rejects look-alike / suffix-injection hosts', () => {
        expect(isWhoamiHostAllowed('evilentourageyearbooks.com', ALLOWED)).toBe(false);
        expect(isWhoamiHostAllowed('entourageyearbooks.com.evil.com', ALLOWED)).toBe(false);
        expect(isWhoamiHostAllowed('example.com', ALLOWED)).toBe(false);
    });
});

// --- validateWhoamiUrl ---

describe('validateWhoamiUrl', () => {
    it('accepts https on an allowed host', () => {
        expect(validateWhoamiUrl('https://edonext-app.entourageyearbooks.com/api/user', ALLOWED).ok).toBe(true);
    });

    it('rejects non-https, off-allowlist, credentials, malformed URLs', () => {
        expect(validateWhoamiUrl('http://edonext-app.entourageyearbooks.com/x', ALLOWED).ok).toBe(false);
        expect(validateWhoamiUrl('https://evil.com/x', ALLOWED).ok).toBe(false);
        expect(validateWhoamiUrl('https://u:p@edonext-app.entourageyearbooks.com/x', ALLOWED).ok).toBe(false);
        expect(validateWhoamiUrl('nope', ALLOWED).ok).toBe(false);
    });

    it('rejects a non-default port', () => {
        expect(validateWhoamiUrl('https://edonext-app.entourageyearbooks.com:8443/api/user', ALLOWED).ok).toBe(false);
    });
});

// --- buildCookieHeader ---

describe('buildCookieHeader', () => {
    it('formats name=value for a valid pair', () => {
        expect(buildCookieHeader('auth_session', 'abc123')).toBe('auth_session=abc123');
    });

    it('returns null for a value containing ;', () => {
        expect(buildCookieHeader('auth_session', 'abc;def')).toBeNull();
    });

    it('returns null for a value containing CRLF', () => {
        expect(buildCookieHeader('auth_session', 'abc\r\ndef')).toBeNull();
    });

    it('returns null for an empty value', () => {
        expect(buildCookieHeader('auth_session', '')).toBeNull();
    });

    it('returns null for a name containing ;', () => {
        expect(buildCookieHeader('auth;session', 'abc')).toBeNull();
    });
});

// --- normalizeBrandUser ---

const EDO_MAP = edo.auth.responseMapping;

describe('normalizeBrandUser', () => {
    it('maps a valid edo response to BrandUser', () => {
        expect(normalizeBrandUser(EDO_MAP, { id: 1004, email: 'a@b.com', name: 'A B', profile_photo_url: null })).toEqual({
            id: '1004',
            email: 'a@b.com',
            displayName: 'A B',
            imageUrl: null,
        });
    });

    it('returns null on missing id', () => {
        expect(normalizeBrandUser(EDO_MAP, { email: 'a@b.com' })).toBeNull();
    });

    it('returns null on an id with a disallowed charset', () => {
        expect(normalizeBrandUser(EDO_MAP, { id: 'bad id!', email: 'a@b.com' })).toBeNull();
    });

    it('returns null on a non-string / missing @ email', () => {
        expect(normalizeBrandUser(EDO_MAP, { id: 1, email: 42 })).toBeNull();
        expect(normalizeBrandUser(EDO_MAP, { id: 1, email: 'no-at-sign' })).toBeNull();
    });

    it('returns null on non-object input', () => {
        expect(normalizeBrandUser(EDO_MAP, null)).toBeNull();
        expect(normalizeBrandUser(EDO_MAP, 'string')).toBeNull();
    });
});

// --- resolveEffectiveAuth (override merge) ---

describe('resolveEffectiveAuth (override merge)', () => {
    it('malformed JSON in the override env var falls back to the registry auth', () => {
        vi.stubEnv('EDO_BRAND_OVERRIDE', '{bad json');
        expect(resolveEffectiveAuth(edo)).toBe(edo.auth);
    });

    it('no override → returns the SAME frozen registry auth reference', () => {
        expect(resolveEffectiveAuth(edo)).toBe(edo.auth);
    });

    it('a valid whoamiUrl override (in-allowlist) is applied', () => {
        vi.stubEnv('EDO_BRAND_OVERRIDE', JSON.stringify({ auth: { whoamiUrl: 'https://staging-edonext-app.entourageyearbooks.com/api/user' } }));
        const eff = resolveEffectiveAuth(edo);
        expect(eff.whoamiUrl).toBe('https://staging-edonext-app.entourageyearbooks.com/api/user');
    });

    it('protected keys (kind, whoamiAllowedHosts) are ignored', () => {
        vi.stubEnv('EDO_BRAND_OVERRIDE', JSON.stringify({ auth: { whoamiAllowedHosts: ['evil.com'], kind: 'capsule' } }));
        const eff = resolveEffectiveAuth(edo);
        expect(eff.kind).toBe('partner-whoami');
        expect(eff.whoamiAllowedHosts).toEqual(['entourageyearbooks.com']);
    });

    it('sessionCookieName longer than 128 chars falls back to the registry value', () => {
        vi.stubEnv('EDO_BRAND_OVERRIDE', JSON.stringify({ auth: { sessionCookieName: 'a'.repeat(129) } }));
        expect(resolveEffectiveSessionCookieName(edo)).toBe('auth_session');
    });

    it('sessionCookieName with a forbidden delimiter falls back to the registry value', () => {
        vi.stubEnv('EDO_BRAND_OVERRIDE', JSON.stringify({ auth: { sessionCookieName: 'auth;session' } }));
        expect(resolveEffectiveSessionCookieName(edo)).toBe('auth_session');
    });

    it('a prototype-pollution payload is inert', () => {
        vi.stubEnv('EDO_BRAND_OVERRIDE', '{"auth":{"__proto__":{"polluted":true}}}');
        const eff = resolveEffectiveAuth(edo) as unknown as Record<string, unknown>;
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
        expect(eff.signInUrl).toBe(edo.auth.signInUrl);
    });

    it('assets/companionHosts are never touched by the override merge (not part of auth)', () => {
        vi.stubEnv('EDO_BRAND_OVERRIDE', JSON.stringify({ assets: { s3Prefix: 'evil/' }, companionHosts: ['evil.com'] }));
        expect(resolveEffectiveAuth(edo)).toBe(edo.auth);
    });

    it('logs a warning on rejection without leaking the rejected value', () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
        vi.stubEnv('EDO_BRAND_OVERRIDE', JSON.stringify({ auth: { whoamiAllowedHosts: ['evil.com'] } }));
        resolveEffectiveAuth(edo);
        expect(warnSpy).toHaveBeenCalled();
        const [context] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
        expect(context.slug).toBe('edo');
        expect(context.field).toBe('whoamiAllowedHosts');
        const serializedCall = JSON.stringify(warnSpy.mock.calls[0]);
        expect(serializedCall).not.toContain('evil.com');
    });
});

// --- resolveValidatedWhoamiTarget (SSRF gate) ---

describe('resolveValidatedWhoamiTarget', () => {
    it('returns ok:true for the registry whoamiUrl (partner-whoami)', () => {
        const result = resolveValidatedWhoamiTarget(edo);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.whoamiUrl.href).toBe('https://edonext-app.entourageyearbooks.com/api/user');
    });

    it('returns ok:false for an off-allowlist override (SSRF gate)', () => {
        vi.stubEnv('EDO_BRAND_OVERRIDE', JSON.stringify({ auth: { whoamiUrl: 'https://evil.com/api/user' } }));
        expect(resolveValidatedWhoamiTarget(edo).ok).toBe(false);
    });

    it('generalized: returns ok:true for a well-formed capsule brand too (not rejected by kind)', () => {
        expect(resolveValidatedWhoamiTarget(CAPSULE_FIXTURE).ok).toBe(true);
    });

    it("abe's placeholder capsule config (empty whoamiUrl) is ok:false — not servable yet", () => {
        expect(resolveValidatedWhoamiTarget(getBaseBrandConfig('abe')).ok).toBe(false);
    });
});
