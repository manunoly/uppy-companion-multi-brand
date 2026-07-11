import { describe, expect, it } from 'vitest';
import { companionBrandConfigSchema } from './brand.schema.js';
import { getBaseBrandConfig, getServableSlugs } from './registry.js';

describe('registry: edo (servable, MVP brand)', () => {
    const edo = getBaseBrandConfig('edo');

    it('is a partner-whoami brand', () => {
        expect(edo.auth.kind).toBe('partner-whoami');
    });

    it('has the entourageyearbooks.com SSRF allowlist', () => {
        expect(edo.auth.whoamiAllowedHosts).toEqual(['entourageyearbooks.com']);
    });

    it('uses the auth_session cookie and the edonext responseMapping', () => {
        expect(edo.auth.sessionCookieName).toBe('auth_session');
        expect(edo.auth.responseMapping).toEqual({
            idField: 'id',
            emailField: 'email',
            nameField: 'name',
            imageField: 'profile_photo_url',
        });
    });

    it('has no S3 key prefix (SA1: uses original/{id}/... directly)', () => {
        expect(edo.assets.s3Prefix).toBe('');
    });

    it('has no requireVerifiedEmail flag (ungated, back-compat) (P1-C2)', () => {
        expect(edo.auth.requireVerifiedEmail).toBeUndefined();
    });

    it('is backed by the entourage-uploads bucket in us-east-1', () => {
        expect(edo.s3.bucket).toBe('entourage-uploads');
        expect(edo.s3.region).toBe('us-east-1');
    });

    it('declares prod AND stage companionHosts (code-only, not overridable)', () => {
        expect(edo.companionHosts).toContain('companion.entourageyearbooks.com');
        expect(edo.companionHosts).toContain('companion.stage.entourageyearbooks.com');
    });

    it('has the ENTOURAGE upload system with Facebook + Url plugins', () => {
        expect(edo.upload.system).toBe('ENTOURAGE');
        expect(edo.upload.systemDetails).toBe('DESIGNER');
        expect(edo.upload.plugins).toEqual(['Facebook', 'Url']);
    });

    it('declares a maxUploadBytes limit', () => {
        expect(edo.limits.maxUploadBytes).toBeGreaterThan(0);
    });

    it('declares companionUrl', () => {
        expect(edo.companionUrl).toBe('https://companion.entourageyearbooks.com');
    });

    it('is deep-frozen', () => {
        expect(Object.isFrozen(edo)).toBe(true);
        expect(Object.isFrozen(edo.auth)).toBe(true);
        expect(Object.isFrozen(edo.s3)).toBe(true);
        expect(Object.isFrozen(edo.companionHosts)).toBe(true);
    });
});

describe('registry: abe (servable, P1-C1)', () => {
    const abe = getBaseBrandConfig('abe');

    it('is a partner-whoami brand', () => {
        expect(abe.auth.kind).toBe('partner-whoami');
    });

    it('has the abeduls.com SSRF allowlist', () => {
        expect(abe.auth.whoamiAllowedHosts).toEqual(['abeduls.com']);
    });

    it('uses the abes_session cookie and the capsule /api/user responseMapping', () => {
        expect(abe.auth.sessionCookieName).toBe('abes_session');
        expect(abe.auth.responseMapping).toEqual({
            idField: 'id',
            emailField: 'email',
            nameField: 'displayName',
            imageField: 'imageUrl',
        });
    });

    it('has no S3 key prefix (SA1: shares capsule bucket 1:1 via original/{id}/...)', () => {
        expect(abe.assets.s3Prefix).toBe('');
    });

    it('boot-validates with requireVerifiedEmail enabled, parity with capsule proxy gate (P1-C2)', () => {
        expect(abe.auth.requireVerifiedEmail).toBe(true);
        expect(() => companionBrandConfigSchema.parse(abe)).not.toThrow();
    });

    it('has an empty registry-literal bucket, resolved at deploy via ABE_S3_BUCKET (P1-G1)', () => {
        expect(abe.s3.bucket).toBe('');
        expect(abe.s3.region).toBe('us-east-1');
    });

    it('declares prod AND local companionHosts (code-only, not overridable)', () => {
        expect(abe.companionHosts).toContain('companion.abeduls.com');
        expect(abe.companionHosts).toContain('companion.abeduls.local');
    });

    it("declares the designer + apex domains that embed /uppy (frame-ancestors/CORS)", () => {
        expect(abe.domains).toEqual(
            expect.arrayContaining(['abeduls.com', 'designer.abeduls.com', 'designer.abeduls.local', 'abeduls.local']),
        );
    });

    it('has the ABEDULS upload system with no plugins (phase-1 local-only)', () => {
        expect(abe.upload.system).toBe('ABEDULS');
        expect(abe.upload.systemDetails).toBe('DESIGNER');
        expect(abe.upload.plugins).toEqual([]);
    });

    it('declares a maxUploadBytes limit and the allowed image content types', () => {
        expect(abe.limits.maxUploadBytes).toBeGreaterThan(0);
        expect(abe.limits.allowedContentTypes).toEqual(
            expect.arrayContaining(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']),
        );
    });

    it('declares companionUrl and the capsule public folders endpoint', () => {
        expect(abe.companionUrl).toBe('https://companion.abeduls.com');
        expect(abe.public?.foldersUrl).toBe('https://abeduls.com/api/folders');
    });

    it('is deep-frozen', () => {
        expect(Object.isFrozen(abe)).toBe(true);
        expect(Object.isFrozen(abe.auth)).toBe(true);
        expect(Object.isFrozen(abe.s3)).toBe(true);
        expect(Object.isFrozen(abe.companionHosts)).toBe(true);
    });
});

describe('registry: picaboo (not servable yet)', () => {
    it('picaboo has an empty companionHosts (no confirmed endpoint)', () => {
        expect(getBaseBrandConfig('picaboo').companionHosts).toEqual([]);
    });
});

describe('getServableSlugs', () => {
    it('returns every brand with a non-empty companionHosts (edo, abe)', () => {
        expect(getServableSlugs()).toEqual(['edo', 'abe']);
    });

    it('excludes picaboo (still not servable)', () => {
        expect(getServableSlugs()).not.toContain('picaboo');
    });
});
