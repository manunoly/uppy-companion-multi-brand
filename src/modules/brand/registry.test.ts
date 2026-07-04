import { describe, expect, it } from 'vitest';
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

describe('registry: abe/picaboo (not servable yet)', () => {
    it('abe has an empty companionHosts (no confirmed capsule endpoint)', () => {
        expect(getBaseBrandConfig('abe').companionHosts).toEqual([]);
    });

    it('picaboo has an empty companionHosts (no confirmed endpoint)', () => {
        expect(getBaseBrandConfig('picaboo').companionHosts).toEqual([]);
    });
});

describe('getServableSlugs', () => {
    it('returns only brands with a non-empty companionHosts', () => {
        expect(getServableSlugs()).toEqual(['edo']);
    });
});
