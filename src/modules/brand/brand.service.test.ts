import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrandRegistry, getAllBrands, resolveBrand } from './brand.service.js';
import { getBaseBrandConfig } from './registry.js';

beforeEach(() => {
    vi.stubEnv('EDO_BRAND_OVERRIDE', '');
    vi.stubEnv('COMPANION_SECRET', '');
    // loadBrandSecrets (SECRETS_SOURCE=env, the default) fails fast without S3
    // credentials — edo's base registry entry has a bucket/region but no
    // credentials, so every real resolveBrand/createBrandRegistry call in this
    // file needs these set, same as Railway service variables would provide.
    vi.stubEnv('EDO_S3_ACCESS_KEY', 'test-access-key');
    vi.stubEnv('EDO_S3_SECRET_KEY', 'test-secret-key');
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
        expect(brand.s3.accessKey).toBe('test-access-key');
        expect(brand.s3.secretKey).toBe('test-secret-key');
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

    it('wires brand.providers from loadBrandSecrets (per-brand OAuth env vars)', () => {
        vi.stubEnv('EDO_DROPBOX_KEY', 'dbx-key');
        vi.stubEnv('EDO_DROPBOX_SECRET', 'dbx-secret');
        const brand = resolveBrand('edo');
        expect(brand.providers.dropbox).toEqual({ key: 'dbx-key', secret: 'dbx-secret' });
    });

    it('lets a per-brand S3 env var override the base registry bucket/region', () => {
        vi.stubEnv('EDO_S3_BUCKET', 'entourage-uploads-stage');
        vi.stubEnv('EDO_S3_REGION', 'us-west-2');
        const brand = resolveBrand('edo');
        expect(brand.s3.bucket).toBe('entourage-uploads-stage');
        expect(brand.s3.region).toBe('us-west-2');
    });

    it('fails fast (via loadBrandSecrets) when a servable brand has no S3 credentials', () => {
        vi.stubEnv('EDO_S3_ACCESS_KEY', '');
        vi.stubEnv('EDO_S3_SECRET_KEY', '');
        expect(() => resolveBrand('edo')).toThrow(/Missing required S3 credentials/);
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

describe('getAllBrands', () => {
    it('returns every resolved brand, skipping unresolved (non-servable) slugs', () => {
        const registry = createBrandRegistry({ secret: 's'.repeat(16) });
        const brands = getAllBrands(registry);
        expect(brands).toHaveLength(1);
        expect(brands[0].slug).toBe('edo');
    });

    it('returns [] for an empty registry', () => {
        expect(getAllBrands({})).toEqual([]);
    });
});
