import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeHost, resolveBrandByHost } from './detect.js';

beforeEach(() => {
    vi.stubEnv('BRAND_FORCE', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('normalizeHost', () => {
    it('lowercases, trims, and strips the port', () => {
        expect(normalizeHost('Companion.Stage.Entourageyearbooks.COM:443')).toBe('companion.stage.entourageyearbooks.com');
        expect(normalizeHost('  companion.entourageyearbooks.com ')).toBe('companion.entourageyearbooks.com');
        expect(normalizeHost(null)).toBe('');
        expect(normalizeHost(undefined)).toBe('');
    });
});

describe('resolveBrandByHost: BRAND_FORCE always wins', () => {
    it('BRAND_FORCE=edo resolves to edo regardless of host', () => {
        vi.stubEnv('BRAND_FORCE', 'edo');
        expect(resolveBrandByHost('unrelated.example.com')).toBe('edo');
    });

    it('an invalid BRAND_FORCE is ignored and the chain continues', () => {
        vi.stubEnv('BRAND_FORCE', 'not-a-brand');
        expect(resolveBrandByHost('companion.entourageyearbooks.com')).toBe('edo');
    });

    it('BRAND_FORCE normalizes whitespace and case', () => {
        vi.stubEnv('BRAND_FORCE', '  EDO ');
        expect(resolveBrandByHost('anything')).toBe('edo');
    });

    it('BRAND_FORCE wins even in production with an unknown host', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('BRAND_FORCE', 'edo');
        expect(resolveBrandByHost('unknown.example.com')).toBe('edo');
    });
});

describe('resolveBrandByHost: exact-match against companionHosts', () => {
    it("matches edo's prod companion host", () => {
        expect(resolveBrandByHost('companion.entourageyearbooks.com')).toBe('edo');
    });

    it("matches edo's stage companion host", () => {
        expect(resolveBrandByHost('companion.stage.entourageyearbooks.com')).toBe('edo');
    });

    it('is case- and port-insensitive', () => {
        expect(resolveBrandByHost('Companion.Entourageyearbooks.COM:443')).toBe('edo');
    });

    it('does NOT suffix-match a different subdomain not in companionHosts', () => {
        // designer.stage.entourageyearbooks.com is a DIFFERENT host than the
        // companion.* hosts in the registry — exact-match must reject it,
        // unlike the suffix-matching resolveBrandBySocketHost pattern (DES-024).
        expect(resolveBrandByHost('designer.stage.entourageyearbooks.com')).toBeNull();
    });

    it('returns null for a host not in any companionHosts', () => {
        expect(resolveBrandByHost('example.com')).toBeNull();
    });
});

describe('resolveBrandByHost: unknown host in production', () => {
    it('rejects (null), never defaults to a brand', () => {
        vi.stubEnv('NODE_ENV', 'production');
        expect(resolveBrandByHost('evil.example.com')).toBeNull();
    });

    it('rejects a missing host', () => {
        vi.stubEnv('NODE_ENV', 'production');
        expect(resolveBrandByHost(undefined)).toBeNull();
    });
});

describe('resolveBrandByHost: dev default is configurable per caller', () => {
    it('without a devDefaultSlug option, dev behaves like prod (null on unknown host)', () => {
        vi.stubEnv('NODE_ENV', 'development');
        expect(resolveBrandByHost('unknown.example.com')).toBeNull();
    });

    it('with a devDefaultSlug option, dev falls back to it on an unknown host', () => {
        vi.stubEnv('NODE_ENV', 'development');
        expect(resolveBrandByHost('unknown.example.com', { devDefaultSlug: 'edo' })).toBe('edo');
    });

    it('the devDefaultSlug option has no effect in production', () => {
        vi.stubEnv('NODE_ENV', 'production');
        expect(resolveBrandByHost('unknown.example.com', { devDefaultSlug: 'edo' })).toBeNull();
    });

    it('a real host match wins over the devDefaultSlug option', () => {
        vi.stubEnv('NODE_ENV', 'development');
        expect(resolveBrandByHost('companion.entourageyearbooks.com', { devDefaultSlug: 'abe' })).toBe('edo');
    });
});
