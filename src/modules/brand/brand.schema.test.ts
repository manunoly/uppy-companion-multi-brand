import { describe, expect, it } from 'vitest';
import { brandOverrideSchema, companionBrandConfigSchema } from './brand.schema.js';
import { getBaseBrandConfig } from './registry.js';

describe('companionBrandConfigSchema', () => {
    it('parses the edo base registry entry', () => {
        expect(() => companionBrandConfigSchema.parse(getBaseBrandConfig('edo'))).not.toThrow();
    });

    it('parses the abe/picaboo placeholder entries (structurally valid, even though not servable)', () => {
        expect(() => companionBrandConfigSchema.parse(getBaseBrandConfig('abe'))).not.toThrow();
        expect(() => companionBrandConfigSchema.parse(getBaseBrandConfig('picaboo'))).not.toThrow();
    });

    it('rejects an unknown upload plugin', () => {
        const edo = getBaseBrandConfig('edo');
        const invalid = { ...edo, upload: { ...edo.upload, plugins: ['NotAPlugin'] } };
        expect(() => companionBrandConfigSchema.parse(invalid)).toThrow();
    });

    it('rejects an unknown auth kind', () => {
        const edo = getBaseBrandConfig('edo');
        const invalid = { ...edo, auth: { ...edo.auth, kind: 'oauth2' } };
        expect(() => companionBrandConfigSchema.parse(invalid)).toThrow();
    });
});

describe('brandOverrideSchema', () => {
    it('parses a realistic EDO_BRAND_OVERRIDE example (stage cookie + whoami)', () => {
        const example = {
            auth: {
                sessionCookieName: 'auth_session_stage',
                whoamiUrl: 'https://edonext-app.stage.entourageyearbooks.com/api/user',
                signInUrl: 'https://edonext.stage.entourageyearbooks.com/login',
                signOutUrl: 'https://edonext-app.stage.entourageyearbooks.com/logout',
            },
        };
        expect(() => brandOverrideSchema.parse(example)).not.toThrow();
    });

    it('rejects a structurally wrong-typed field (whoamiAllowedHosts as a string, not an array)', () => {
        expect(() => brandOverrideSchema.parse({ auth: { whoamiAllowedHosts: 'not-an-array' } })).toThrow();
    });

    it('accepts an override with unrecognized top-level keys (passthrough; identity.ts is the runtime authority)', () => {
        expect(() => brandOverrideSchema.parse({ auth: { signInUrl: 'https://x.example/login' }, somethingElse: true })).not.toThrow();
    });
});
