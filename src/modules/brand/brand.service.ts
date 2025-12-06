import type { Brand, BrandRegistry, BrandS3Config, BrandProviderConfig } from './brand.types.js';
import { getS3Client } from '../../lib/aws/s3Client.js';

/**
 * Normalizes a brand slug to lowercase alphanumeric with dashes
 */
export const normalizeBrandSlug = (value: string | undefined | null): string => {
    return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
};

/**
 * Converts a brand slug to an environment variable prefix
 * e.g., "my-brand" -> "MY_BRAND"
 */
const slugToEnvPrefix = (slug: string): string => {
    return normalizeBrandSlug(slug).replace(/-/g, '_').toUpperCase();
};

/**
 * Reads a brand-specific environment variable
 */
const readBrandEnv = (
    slug: string,
    suffix: string,
    fallback: string | null = null
): string | null => {
    const envKey = `${slugToEnvPrefix(slug)}_${suffix}`;
    const value = process.env[envKey];
    if (value == null || value === '') return fallback;
    return value;
};

/**
 * Parses a boolean from environment variable
 */
const parseBoolean = (value: string | null | undefined, fallback: boolean): boolean => {
    if (value == null) return fallback;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
};

/**
 * Creates provider configuration if keys exist
 */
const createProviderConfig = (
    slug: string,
    providerName: string,
    globalKeyEnv: string,
    globalSecretEnv: string
): BrandProviderConfig | undefined => {
    const key = readBrandEnv(slug, `COMPANION_${providerName.toUpperCase()}_KEY`, process.env[globalKeyEnv] ?? null);
    const secret = readBrandEnv(slug, `COMPANION_${providerName.toUpperCase()}_SECRET`, process.env[globalSecretEnv] ?? null);

    if (key && secret) {
        return { key, secret };
    }
    return undefined;
};

/**
 * Creates S3 configuration for a brand
 */
const createS3Config = (slug: string): BrandS3Config => {
    const config: BrandS3Config = {
        bucket: readBrandEnv(slug, 'AWS_BUCKET_NAME', process.env.AWS_BUCKET_NAME ?? '') ?? '',
        region: readBrandEnv(slug, 'AWS_REGION', process.env.AWS_REGION ?? '') ?? '',
        accessKey: readBrandEnv(slug, 'AWS_ACCESS_KEY_ID', process.env.AWS_ACCESS_KEY_ID ?? null) ?? undefined,
        secretKey: readBrandEnv(slug, 'AWS_SECRET_ACCESS_KEY', process.env.AWS_SECRET_ACCESS_KEY ?? null) ?? undefined,
        useAccelerateEndpoint: parseBoolean(
            readBrandEnv(slug, 'COMPANION_AWS_ACCELERATE_ENDPOINT', null),
            false
        ),
    };

    if (config.accessKey && config.secretKey) {
        config.client = getS3Client({
            regionParam: config.region,
            accessKeyIdParam: config.accessKey,
            secretAccessKeyParam: config.secretKey,
        });
    }

    return config;
};

/**
 * Parses CORS origins from environment
 */
const parseCorsOrigins = (slug: string, defaults: (string | RegExp)[]): (string | RegExp)[] => {
    const raw = readBrandEnv(slug, 'COMPANION_CORS_ORIGINS_JSON', null);
    if (!raw) return defaults;

    try {
        const parsed = JSON.parse(raw) as unknown[];
        if (!Array.isArray(parsed)) return defaults;

        return parsed.map((entry) => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object' && 'regex' in entry) {
                const regexEntry = entry as { regex: string; flags?: string };
                return new RegExp(regexEntry.regex, regexEntry.flags ?? undefined);
            }
            return null;
        }).filter((x): x is string | RegExp => x !== null);
    } catch {
        console.warn(`[brand] Invalid CORS origins JSON for brand "${slug}"`);
        return defaults;
    }
};

/**
 * Creates a brand descriptor from environment variables
 */
export const createBrand = (
    slug: string,
    defaults: {
        corsOrigins: (string | RegExp)[];
        secret: string;
        filePath: string;
        host: string;
        protocol: 'http' | 'https';
    }
): Brand => {
    const mountPath = `/${slug}`;
    const serverHost = readBrandEnv(slug, 'COMPANION_HOST', defaults.host) ?? defaults.host;
    const serverProtocol = (readBrandEnv(slug, 'COMPANION_PROTOCOL', defaults.protocol) ?? defaults.protocol) as 'http' | 'https';

    return {
        id: slug,
        displayName: readBrandEnv(slug, 'DISPLAY_NAME', slug) ?? slug,

        // Auth
        authUrl: readBrandEnv(slug, 'AUTH_URL', process.env.AUTH_URL ?? null),
        authCookieName: readBrandEnv(slug, 'AUTH_COOKIE_NAME', 'session') ?? 'session',
        projectCookieName: readBrandEnv(slug, 'PROJECT_COOKIE_NAME', 'frame_project_id') ?? 'frame_project_id',

        // S3
        s3: createS3Config(slug),

        // Providers
        providers: {
            google: createProviderConfig(slug, 'google', 'COMPANION_GOOGLE_KEY', 'COMPANION_GOOGLE_SECRET'),
            dropbox: createProviderConfig(slug, 'dropbox', 'COMPANION_DROPBOX_KEY', 'COMPANION_DROPBOX_SECRET'),
            facebook: createProviderConfig(slug, 'facebook', 'COMPANION_FACEBOOK_KEY', 'COMPANION_FACEBOOK_SECRET'),
            instagram: createProviderConfig(slug, 'instagram', 'COMPANION_INSTAGRAM_KEY', 'COMPANION_INSTAGRAM_SECRET'),
            onedrive: createProviderConfig(slug, 'onedrive', 'COMPANION_ONEDRIVE_KEY', 'COMPANION_ONEDRIVE_SECRET'),
            box: createProviderConfig(slug, 'box', 'COMPANION_BOX_KEY', 'COMPANION_BOX_SECRET'),
            unsplash: createProviderConfig(slug, 'unsplash', 'COMPANION_UNSPLASH_KEY', 'COMPANION_UNSPLASH_SECRET'),
            zoom: createProviderConfig(slug, 'zoom', 'COMPANION_ZOOM_KEY', 'COMPANION_ZOOM_SECRET'),
        },

        // CORS & Upload
        corsOrigins: parseCorsOrigins(slug, defaults.corsOrigins),
        uploadUrls: (readBrandEnv(slug, 'COMPANION_UPLOAD_URLS', '*') ?? '*').split(',').map(s => s.trim()).filter(Boolean),

        // Server
        secret: readBrandEnv(slug, 'COMPANION_SECRET', defaults.secret) ?? defaults.secret,
        server: {
            host: serverHost,
            protocol: serverProtocol,
            path: mountPath,
        },
        filePath: readBrandEnv(slug, 'COMPANION_FILE_PATH', defaults.filePath) ?? defaults.filePath,
    };
};

/**
 * Creates a brand registry from environment configuration
 */
export const createBrandRegistry = (defaults: {
    corsOrigins: (string | RegExp)[];
    secret: string;
    filePath: string;
    host: string;
    protocol: 'http' | 'https';
}): BrandRegistry => {
    const rawBrandList = process.env.COMPANION_BRANDS ?? 'default';
    const slugs = [...new Set(
        rawBrandList.split(',').map(normalizeBrandSlug).filter(Boolean)
    )];

    if (slugs.length === 0) {
        throw new Error('No brands configured. Set COMPANION_BRANDS environment variable.');
    }

    const brands = new Map<string, Brand>();

    for (const slug of slugs) {
        const brand = createBrand(slug, defaults);
        brands.set(slug, brand);
        console.log(`[brand] Registered brand "${slug}"`);
    }

    const defaultBrand = brands.get(slugs[0]) ?? null;

    return { brands, defaultBrand };
};

/**
 * Resolves a brand by identifier
 */
export const resolveBrand = (
    registry: BrandRegistry,
    identifier: string | undefined | null
): Brand | null => {
    if (!identifier) return null;
    return registry.brands.get(normalizeBrandSlug(identifier)) ?? null;
};

/**
 * Gets all brands as an array
 */
export const getAllBrands = (registry: BrandRegistry): Brand[] => {
    return Array.from(registry.brands.values());
};
