import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBrand, createBrandRegistry, resolveBrand, getAllBrands } from './brand.service.js';
import type { CreateBrandRegistryOptions } from './brand.service.js';

vi.mock('../../lib/aws/s3Client.js', () => ({
    getS3Client: vi.fn(() => ({ /* fake S3Client */ })),
}));

const baseDefaults = (): CreateBrandRegistryOptions => ({
    corsOrigins: [],
    secret: 'test-secret-value-1234567890',
    filePath: '/tmp/',
    host: 'localhost:3020',
    protocol: 'http',
    brands: 'a',
    brandConfigs: {},
    publicDefaults: {
        backendUrl: 'http://default-backend',
    },
    s3Defaults: {},
    providerDefaults: {},
});

describe('createBrand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses defaults when brandConfigs is empty', () => {
        const brand = createBrand('a', baseDefaults());
        expect(brand.id).toBe('a');
        expect(brand.displayName).toBe('a');
        expect(brand.rootDomain).toBeNull();
        expect(brand.auth.url).toBeNull();
        expect(brand.auth.cookieName).toBe('session');
        expect(brand.public.backendUrl).toBe('http://default-backend');
        expect(brand.uploadUrls).toEqual(['*']);
    });

    it('JSON config wins over global defaults for s3.bucket', () => {
        const opts = baseDefaults();
        opts.s3Defaults = { bucket: 'global-bucket', region: 'us-east-1' };
        opts.brandConfigs = { a: { s3: { bucket: 'json-bucket', region: 'us-east-1' } } };
        const brand = createBrand('a', opts);
        expect(brand.s3.bucket).toBe('json-bucket');
    });

    it('falls back to globals when JSON omits a field', () => {
        const opts = baseDefaults();
        opts.s3Defaults = { bucket: 'global-bucket', region: 'us-east-1' };
        opts.brandConfigs = { a: {} };
        const brand = createBrand('a', opts);
        expect(brand.s3.bucket).toBe('global-bucket');
    });

    it('sets rootDomain from JSON config', () => {
        const opts = baseDefaults();
        opts.brandConfigs = { a: { rootDomain: 'a.example.com', auth: { url: 'https://api.a.example.com' } } };
        const brand = createBrand('a', opts);
        expect(brand.rootDomain).toBe('a.example.com');
        expect(brand.auth.url).toBe('https://api.a.example.com');
    });

    it('legacy authUrl populates auth.url when nested is absent', () => {
        const opts = baseDefaults();
        opts.brandConfigs = { a: { rootDomain: 'a.example.com', authUrl: 'https://legacy/' } };
        const brand = createBrand('a', opts);
        expect(brand.auth.url).toBe('https://legacy/');
    });

    it('nested auth.url wins over legacy authUrl', () => {
        const opts = baseDefaults();
        opts.brandConfigs = { a: { rootDomain: 'a.example.com', authUrl: 'https://legacy/', auth: { url: 'https://nested/' } } };
        const brand = createBrand('a', opts);
        expect(brand.auth.url).toBe('https://nested/');
    });

    it('parses enabledPlugins case-insensitively against the allowlist', () => {
        const opts = baseDefaults();
        opts.brandConfigs = { a: { enabledPlugins: 'Url, GOOGLEDRIVEPICKER, dropbox' } };
        const brand = createBrand('a', opts);
        expect(brand.enabledPlugins).toEqual(['Url', 'GoogleDrivePicker', 'Dropbox']);
    });

    it('silently drops unknown plugin names', () => {
        const opts = baseDefaults();
        opts.brandConfigs = { a: { enabledPlugins: 'Url, FakePlugin, Dropbox' } };
        const brand = createBrand('a', opts);
        expect(brand.enabledPlugins).toEqual(['Url', 'Dropbox']);
    });

    it('returns empty enabledPlugins when not configured', () => {
        const brand = createBrand('a', baseDefaults());
        expect(brand.enabledPlugins).toEqual([]);
    });

    it('builds Google provider config from clientId fallback chain', () => {
        const opts = baseDefaults();
        opts.providerDefaults.google = { clientId: 'global-cid', clientSecret: 'global-csec' };
        opts.brandConfigs = { a: { providers: { google: { clientId: 'brand-cid' } } } };
        const brand = createBrand('a', opts);
        expect(brand.providers.google?.clientId).toBe('brand-cid');
        expect(brand.providers.google?.clientSecret).toBe('global-csec');
    });

    it('omits Google provider when no clientId is anywhere', () => {
        const brand = createBrand('a', baseDefaults());
        expect(brand.providers.google).toBeUndefined();
    });

    it('builds Dropbox provider when key+secret present in JSON', () => {
        const opts = baseDefaults();
        opts.brandConfigs = { a: { providers: { dropbox: { key: 'k', secret: 's' } } } };
        const brand = createBrand('a', opts);
        expect(brand.providers.dropbox).toEqual({ key: 'k', secret: 's' });
    });

    it('omits Dropbox provider when only key is present (no allowKeyOnly)', () => {
        const opts = baseDefaults();
        opts.brandConfigs = { a: { providers: { dropbox: { key: 'k' } } } };
        const brand = createBrand('a', opts);
        expect(brand.providers.dropbox).toBeUndefined();
    });

    it('sets server.host/protocol/path from defaults', () => {
        const opts = baseDefaults();
        opts.host = 'example.com';
        opts.protocol = 'https';
        const brand = createBrand('myslug', opts);
        expect(brand.server.host).toBe('example.com');
        expect(brand.server.protocol).toBe('https');
        expect(brand.server.path).toBe('/myslug');
    });
});

describe('createBrandRegistry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('builds map keyed by slug for each CSV entry', () => {
        const opts = baseDefaults();
        opts.brands = 'a,b,c';
        const reg = createBrandRegistry(opts);
        expect([...reg.brands.keys()].sort()).toEqual(['a', 'b', 'c']);
    });

    it('first slug is the default brand', () => {
        const opts = baseDefaults();
        opts.brands = 'a,b';
        const reg = createBrandRegistry(opts);
        expect(reg.defaultBrand?.id).toBe('a');
    });

    it('deduplicates duplicate slugs', () => {
        const opts = baseDefaults();
        opts.brands = 'a,a,b';
        const reg = createBrandRegistry(opts);
        expect(reg.brands.size).toBe(2);
    });

    it('throws when brands string is empty', () => {
        const opts = baseDefaults();
        opts.brands = '';
        expect(() => createBrandRegistry(opts)).toThrow(/No brands configured/);
    });

    it('throws when brands is whitespace only', () => {
        const opts = baseDefaults();
        opts.brands = '   ,  ';
        expect(() => createBrandRegistry(opts)).toThrow(/No brands configured/);
    });
});

describe('resolveBrand', () => {
    it('returns brand for matching slug', () => {
        const opts = baseDefaults();
        opts.brands = 'a,b';
        const reg = createBrandRegistry(opts);
        expect(resolveBrand(reg, 'a')?.id).toBe('a');
    });

    it('normalizes input slug before lookup', () => {
        const opts = baseDefaults();
        opts.brands = 'brand-x';
        const reg = createBrandRegistry(opts);
        expect(resolveBrand(reg, 'BRAND-X')?.id).toBe('brand-x');
    });

    it('returns null for unknown slug', () => {
        const opts = baseDefaults();
        const reg = createBrandRegistry(opts);
        expect(resolveBrand(reg, 'nope')).toBeNull();
    });

    it('returns null for empty/null/undefined input', () => {
        const opts = baseDefaults();
        const reg = createBrandRegistry(opts);
        expect(resolveBrand(reg, '')).toBeNull();
        expect(resolveBrand(reg, null)).toBeNull();
        expect(resolveBrand(reg, undefined)).toBeNull();
    });
});

describe('getAllBrands', () => {
    it('returns all brands in insertion order', () => {
        const opts = baseDefaults();
        opts.brands = 'a,b,c';
        const reg = createBrandRegistry(opts);
        expect(getAllBrands(reg).map(b => b.id)).toEqual(['a', 'b', 'c']);
    });
});
