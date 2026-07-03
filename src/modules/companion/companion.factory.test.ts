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

    it('server.validHosts is present and derived from companionUrl + companionHosts (H7)', () => {
        const brand = makeBrand({
            companionUrl: 'https://companion.entourageyearbooks.com',
            companionHosts: ['companion.entourageyearbooks.com', 'companion.stage.entourageyearbooks.com'],
        });
        const options = buildCompanionOptions(brand, { protocol: 'https' });

        expect(options.server.validHosts).toEqual(
            expect.arrayContaining(['companion.entourageyearbooks.com', 'companion.stage.entourageyearbooks.com']),
        );
    });

    it('validHosts does not include arbitrary/unrelated hosts (redirect_uri allowlist, H7)', () => {
        const brand = makeBrand({
            companionUrl: 'https://companion.entourageyearbooks.com',
            companionHosts: ['companion.entourageyearbooks.com'],
        });
        const options = buildCompanionOptions(brand, { protocol: 'https' });
        expect(options.server.validHosts).not.toContain('evil.example.com');
    });

    it('validHosts still includes the companionUrl host even if absent from companionHosts', () => {
        const brand = makeBrand({
            companionUrl: 'https://companion.other.example.com',
            companionHosts: ['companion.entourageyearbooks.com'],
        });
        const options = buildCompanionOptions(brand, { protocol: 'https' });
        expect(options.server.validHosts).toContain('companion.other.example.com');
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
