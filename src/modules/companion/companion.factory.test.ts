import { describe, it, expect } from 'vitest';
import { buildCompanionOptions } from './companion.factory.js';
import { makeBrand } from '../../test-utils/fixtures.js';

// Task 4.3 (spec D9, closes H1/H2/H7): the pre-abeduls3-alignment factory
// hardcoded `allowLocalUrls: true` and `uploadUrls: ['*']` unconditionally —
// an SSRF-adjacent config regardless of environment. These tests assert the
// hardened, environment-aware/derived replacements.

describe('buildCompanionOptions — SSRF hardening (D9)', () => {
    it('allowLocalUrls is true when env.protocol is http (dev only)', () => {
        const brand = makeBrand();
        const options = buildCompanionOptions(brand, { protocol: 'http' });
        expect(options.allowLocalUrls).toBe(true);
    });

    it('allowLocalUrls is false when env.protocol is https (prod)', () => {
        const brand = makeBrand();
        const options = buildCompanionOptions(brand, { protocol: 'https' });
        expect(options.allowLocalUrls).toBe(false);
    });

    it('uploadUrls is derived — never the unhardened wildcard', () => {
        const brand = makeBrand({
            companionUrl: 'https://companion.entourageyearbooks.com',
            companionHosts: ['companion.entourageyearbooks.com', 'companion.stage.entourageyearbooks.com'],
            s3: { bucket: 'entourage-uploads', region: 'us-east-1' },
        });
        const options = buildCompanionOptions(brand, { protocol: 'https' });

        expect(options.uploadUrls).not.toEqual(['*']);
        expect(options.uploadUrls.length).toBeGreaterThan(0);

        const matchesAny = (url: string): boolean =>
            options.uploadUrls.some((pattern) => url === pattern || new RegExp(pattern).test(url));

        expect(matchesAny('https://companion.entourageyearbooks.com/uppy/s3/multipart')).toBe(true);
        expect(matchesAny('https://entourage-uploads.s3.us-east-1.amazonaws.com/original/1/x')).toBe(true);
        expect(matchesAny('https://evil.example.com/steal')).toBe(false);
    });

    // Companion consumes `validHosts` via its own `hasMatch(value, criteria)`
    // (`value === i || new RegExp(i).test(value)`) — these tests exercise
    // that exact consumption pattern rather than asserting on the raw
    // (now anchored/escaped, BAJO-2) pattern strings themselves.
    const matchesHost = (validHosts: string[] | undefined, host: string): boolean =>
        (validHosts ?? []).some((pattern) => pattern === host || new RegExp(pattern).test(host));

    it('server.validHosts is present and derived from companionUrl + companionHosts (H7)', () => {
        const brand = makeBrand({
            companionUrl: 'https://companion.entourageyearbooks.com',
            companionHosts: ['companion.entourageyearbooks.com', 'companion.stage.entourageyearbooks.com'],
        });
        const options = buildCompanionOptions(brand, { protocol: 'https' });

        expect(matchesHost(options.server.validHosts, 'companion.entourageyearbooks.com')).toBe(true);
        expect(matchesHost(options.server.validHosts, 'companion.stage.entourageyearbooks.com')).toBe(true);
    });

    it('validHosts does not include arbitrary/unrelated hosts (redirect_uri allowlist, H7)', () => {
        const brand = makeBrand({
            companionUrl: 'https://companion.entourageyearbooks.com',
            companionHosts: ['companion.entourageyearbooks.com'],
        });
        const options = buildCompanionOptions(brand, { protocol: 'https' });
        expect(options.server.validHosts).not.toContain('evil.example.com');
        expect(matchesHost(options.server.validHosts, 'evil.example.com')).toBe(false);
    });

    it('validHosts still includes the companionUrl host even if absent from companionHosts', () => {
        const brand = makeBrand({
            companionUrl: 'https://companion.other.example.com',
            companionHosts: ['companion.entourageyearbooks.com'],
        });
        const options = buildCompanionOptions(brand, { protocol: 'https' });
        expect(matchesHost(options.server.validHosts, 'companion.other.example.com')).toBe(true);
    });

    // @uppy/companion's validateConfig throws "If you want to use '/' as
    // server.path, leave the 'path' variable unset" for the literal string
    // '/' (github.com/transloadit/uppy/issues/4271). A companionUrl with no
    // subpath (the common case — e.g. https://companion.abeduls.com) must
    // NOT produce server.path: '/'; it must be left unset.
    it('server.path is unset (not "/") when companionUrl has no subpath', () => {
        const brand = makeBrand({ companionUrl: 'https://companion.abeduls.com' });
        const options = buildCompanionOptions(brand, { protocol: 'https' });
        expect(options.server.path).toBeUndefined();
    });

    it('server.path is preserved when companionUrl has a real subpath', () => {
        const brand = makeBrand({ companionUrl: 'https://shared.example.com/abe' });
        const options = buildCompanionOptions(brand, { protocol: 'https' });
        expect(options.server.path).toBe('/abe');
    });

    // Security review BAJO-2: Companion's own `hasMatch` treats every
    // `validHosts` entry as an UNANCHORED regex with no escaping of its own.
    // A raw hostname like `companion.entourageyearbooks.com` would let the
    // unescaped `.` match ANY character and, being unanchored, match as a
    // mere substring of a longer attacker-influenced host. Anchoring +
    // escaping (companion.factory.ts#buildValidHosts) closes that without
    // narrowing what's legitimately allowed.
    it('validHosts entries are anchored/escaped so an attacker cannot satisfy them with a superstring/wildcard-dot host (BAJO-2)', () => {
        const brand = makeBrand({
            companionUrl: 'https://companion.entourageyearbooks.com',
            companionHosts: ['companion.entourageyearbooks.com'],
        });
        const options = buildCompanionOptions(brand, { protocol: 'https' });

        // The legitimate host still matches.
        expect(matchesHost(options.server.validHosts, 'companion.entourageyearbooks.com')).toBe(true);
        // A host that merely CONTAINS the legit host as a substring must not.
        expect(matchesHost(options.server.validHosts, 'evil-companion.entourageyearbooks.com.attacker.test')).toBe(false);
        // If '.' were left unescaped (matching ANY character), this would
        // wrongly match too.
        expect(matchesHost(options.server.validHosts, 'companionXentourageyearbooksXcom')).toBe(false);
    });

    describe('provider mapping from brand.upload.plugins (EdoUploadPlugin)', () => {
        const providers = {
            google: {
                clientId: 'g-id',
                clientSecret: 'g-secret',
                driveApiKey: 'drive-key',
                photosApiKey: 'photos-key',
                appId: 'app-1',
            },
            dropbox: { key: 'db-key', secret: 'db-secret' },
            facebook: { key: 'fb-key', secret: 'fb-secret' },
        };

        it('only wires the provider whose plugin is enabled', () => {
            const brand = makeBrand({ upload: { plugins: ['Dropbox'], system: 'T', systemDetails: 'T' }, providers });
            const options = buildCompanionOptions(brand, { protocol: 'https' });
            expect(options.providerOptions?.dropbox).toBeDefined();
            expect(options.providerOptions?.drive).toBeUndefined();
            expect(options.providerOptions?.facebook).toBeUndefined();
        });

        it('the Url plugin enables no OAuth provider', () => {
            const brand = makeBrand({ upload: { plugins: ['Url'], system: 'T', systemDetails: 'T' }, providers });
            const options = buildCompanionOptions(brand, { protocol: 'https' });
            expect(options.providerOptions).toEqual({});
        });

        it('GoogleDrivePicker wires the drive provider from brand.providers.google', () => {
            const brand = makeBrand({
                upload: { plugins: ['GoogleDrivePicker'], system: 'T', systemDetails: 'T' },
                providers,
            });
            const options = buildCompanionOptions(brand, { protocol: 'https' });
            expect(options.providerOptions?.drive).toMatchObject({ key: 'g-id', secret: 'g-secret' });
        });

        it('GooglePhotosPicker also wires the drive provider (same Google OAuth backend)', () => {
            const brand = makeBrand({
                upload: { plugins: ['GooglePhotosPicker'], system: 'T', systemDetails: 'T' },
                providers,
            });
            const options = buildCompanionOptions(brand, { protocol: 'https' });
            expect(options.providerOptions?.drive).toMatchObject({ key: 'g-id', secret: 'g-secret' });
        });

        it('does not wire a provider that has no credentials even if its plugin is enabled', () => {
            const brand = makeBrand({ upload: { plugins: ['Facebook'], system: 'T', systemDetails: 'T' }, providers: {} });
            const options = buildCompanionOptions(brand, { protocol: 'https' });
            expect(options.providerOptions?.facebook).toBeUndefined();
        });

        it('enabling multiple plugins wires multiple providers', () => {
            const brand = makeBrand({
                upload: { plugins: ['Dropbox', 'Facebook'], system: 'T', systemDetails: 'T' },
                providers,
            });
            const options = buildCompanionOptions(brand, { protocol: 'https' });
            expect(options.providerOptions?.dropbox).toBeDefined();
            expect(options.providerOptions?.facebook).toBeDefined();
            expect(options.providerOptions?.drive).toBeUndefined();
        });
    });
});
