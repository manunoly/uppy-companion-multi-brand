import type { Brand, BrandRegistry, BrandS3Config, BrandProviderConfig, BrandConfigJSON } from './brand.types.js';
import { getS3Client } from '../../lib/aws/s3Client.js';

/**
 * Normalizes a brand slug to lowercase alphanumeric with dashes
 */
export const normalizeBrandSlug = (value: string | undefined | null): string => {
    return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
};

/**
 * Parses the JSON configuration for a brand from the environment variable
 */
const parseBrandConfig = (slug: string): BrandConfigJSON | null => {
    const envKey = normalizeBrandSlug(slug).replace(/-/g, '_').toUpperCase();
    const rawConfig = process.env[envKey];

    if (!rawConfig) return null;

    try {
        return JSON.parse(rawConfig) as BrandConfigJSON;
    } catch (error) {
        console.error(`[brand] Failed to parse JSON configuration for brand "${slug}" (Env: ${envKey})`, error);
        return null;
    }
};

/**
 * Creates provider configuration from JSON or Global Defaults
 */
const createProviderConfig = (
    providerConfig: BrandProviderConfig | undefined,
    globalKeyEnv: string,
    globalSecretEnv: string
): BrandProviderConfig | undefined => {
    // Prefer brand specific config
    if (providerConfig?.key && providerConfig?.secret) {
        return providerConfig;
    }

    // Fallback to global env
    const globalKey = process.env[globalKeyEnv];
    const globalSecret = process.env[globalSecretEnv];

    if (globalKey && globalSecret) {
        return { key: globalKey, secret: globalSecret };
    }

    return undefined;
};

/**
 * Creates S3 configuration for a brand
 */
const createS3Config = (s3Config: BrandConfigJSON['s3'] | undefined): BrandS3Config => {
    const config: BrandS3Config = {
        bucket: s3Config?.bucket ?? process.env.AWS_BUCKET_NAME ?? '',
        region: s3Config?.region ?? process.env.AWS_REGION ?? '',
        accessKey: s3Config?.accessKey ?? process.env.AWS_ACCESS_KEY_ID ?? undefined,
        secretKey: s3Config?.secretKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? undefined,
        useAccelerateEndpoint: s3Config?.useAccelerateEndpoint ?? false,
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
 * Parses CORS origins
 */
const parseCorsOrigins = (
    configuredOrigins: string[] | undefined,
    defaults: (string | RegExp)[]
): (string | RegExp)[] => {
    if (configuredOrigins && Array.isArray(configuredOrigins)) {
        return configuredOrigins;
    }
    return defaults;
};

/**
 * Creates a brand descriptor from environment variables and JSON config
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

    // Load JSON config
    const config = parseBrandConfig(slug) ?? {};

    const serverHost = defaults.host;
    const serverProtocol = defaults.protocol;

    return {
        id: slug,
        displayName: slug, // JSON config could add displayName if needed, for now using slug

        // Auth
        authUrl: config.authUrl ?? null,
        authCookieName: config.authCookieName ?? 'session',
        projectCookieName: config.projectCookieName ?? 'frame_project_id',

        // S3
        s3: createS3Config(config.s3),

        // Providers
        providers: {
            google: createProviderConfig(config.providers?.google, 'COMPANION_GOOGLE_KEY', 'COMPANION_GOOGLE_SECRET'),
            dropbox: createProviderConfig(config.providers?.dropbox, 'COMPANION_DROPBOX_KEY', 'COMPANION_DROPBOX_SECRET'),
            facebook: createProviderConfig(config.providers?.facebook, 'COMPANION_FACEBOOK_KEY', 'COMPANION_FACEBOOK_SECRET'),
            instagram: createProviderConfig(config.providers?.instagram, 'COMPANION_INSTAGRAM_KEY', 'COMPANION_INSTAGRAM_SECRET'),
            onedrive: createProviderConfig(config.providers?.onedrive, 'COMPANION_ONEDRIVE_KEY', 'COMPANION_ONEDRIVE_SECRET'),
            box: createProviderConfig(config.providers?.box, 'COMPANION_BOX_KEY', 'COMPANION_BOX_SECRET'),
            unsplash: createProviderConfig(config.providers?.unsplash, 'COMPANION_UNSPLASH_KEY', 'COMPANION_UNSPLASH_SECRET'),
            zoom: createProviderConfig(config.providers?.zoom, 'COMPANION_ZOOM_KEY', 'COMPANION_ZOOM_SECRET'),
        },

        // CORS & Upload
        corsOrigins: parseCorsOrigins(config.corsOrigins, defaults.corsOrigins),
        uploadUrls: config.uploadUrls ?? ['*'],

        publicBackendUrl: config.publicBackendUrl ?? process.env.PUBLIC_BACKEND_URL ?? 'http://localhost',

        // Server
        secret: defaults.secret,
        server: {
            host: serverHost,
            protocol: serverProtocol,
            path: mountPath,
        },
        filePath: defaults.filePath,
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
