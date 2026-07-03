import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrandRegistry, resolveBrand } from './brand.service.next.js';
import { getBaseBrandConfig } from './registry.js';

beforeEach(() => {
    vi.stubEnv('EDO_BRAND_OVERRIDE', '');
    vi.stubEnv('COMPANION_SECRET', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('resolveBrand', () => {
    it('resolves edo into a fully-formed Brand with an initialized S3Client', () => {
        const brand = resolveBrand('edo', { secret: 'test-secret-at-least-16-chars' });
        expect(brand.slug).toBe('edo');
        expect(brand.auth.kind).toBe('partner-whoami');
        expect(brand.secret).toBe('test-secret-at-least-16-chars');
        expect(brand.s3.bucket).toBe('entourage-uploads');
        expect(brand.s3.client).toBeInstanceOf(S3Client);
    });

    it('applies a validated EDO_BRAND_OVERRIDE on top of the registry (auth only)', () => {
        vi.stubEnv(
            'EDO_BRAND_OVERRIDE',
            JSON.stringify({
                auth: {
                    sessionCookieName: 'auth_session_stage',
                    whoamiUrl: 'https://edonext-app.stage.entourageyearbooks.com/api/user',
                },
            }),
        );
        const brand = resolveBrand('edo');
        expect(brand.auth.sessionCookieName).toBe('auth_session_stage');
        expect(brand.auth.whoamiUrl).toBe('https://edonext-app.stage.entourageyearbooks.com/api/user');
        // Code-only fields are untouched by the override.
        expect(brand.companionHosts).toEqual(getBaseBrandConfig('edo').companionHosts);
        expect(brand.assets.s3Prefix).toBe('');
    });

    it('falls back to COMPANION_SECRET from env when no explicit secret is given', () => {
        vi.stubEnv('COMPANION_SECRET', 'env-secret-1234567890');
        const brand = resolveBrand('edo');
        expect(brand.secret).toBe('env-secret-1234567890');
    });
});

describe('createBrandRegistry', () => {
    it('produces a Brand for every servable slug (edo only, for now)', () => {
        const registry = createBrandRegistry({ secret: 's'.repeat(16) });
        expect(Object.keys(registry)).toEqual(['edo']);
        expect(registry.edo?.s3.client).toBeInstanceOf(S3Client);
        expect(registry.abe).toBeUndefined();
    });
});
