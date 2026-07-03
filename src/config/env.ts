import { envSchema, type EnvConfig } from './env.schema.js';
import { brandConfigSchema } from '../modules/brand/brand.schema.js';
import type { BrandConfigJSON } from '../modules/brand/brand.types.js';
import { normalizeBrandSlug } from '../modules/brand/brand.utils.js';

/**
 * Parses a comma-separated string into an array
 */
const parseCsv = (value: string | undefined): string[] => {
    if (!value) return [];
    return value.split(',').map(s => s.trim()).filter(Boolean);
};

/**
 * Coerces a string to a number with fallback
 */
const coerceNumber = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const toBrandEnvKey = (slug: string): string => {
    return normalizeBrandSlug(slug).replace(/-/g, '_').toUpperCase();
};

const parseBrandConfigs = (brands: string): Record<string, BrandConfigJSON> => {
    const slugs = [...new Set(
        brands.split(',').map(normalizeBrandSlug).filter(Boolean)
    )];

    const parsedConfigs: Record<string, BrandConfigJSON> = {};

    for (const slug of slugs) {
        const envKey = toBrandEnvKey(slug);
        const rawConfig = process.env[envKey];

        if (!rawConfig) {
            continue;
        }

        let jsonConfig: unknown;
        try {
            jsonConfig = JSON.parse(rawConfig);
        } catch (error) {
            throw new Error(`Invalid JSON for brand "${slug}" in env var ${envKey}`, { cause: error });
        }

        const parsed = brandConfigSchema.safeParse(jsonConfig);
        if (!parsed.success) {
            throw new Error(`Invalid brand configuration for "${slug}" in env var ${envKey}: ${parsed.error.message}`);
        }

        parsedConfigs[slug] = parsed.data;
    }

    return parsedConfigs;
};

/**
 * Derives environment configuration from process.env
 */
const deriveEnv = (): EnvConfig => {
    const port = coerceNumber(process.env.COMPANION_PORT ?? process.env.PORT, 3020);
    const host = process.env.COMPANION_BIND_HOST ?? process.env.HOST ?? '0.0.0.0';
    const protocol = (process.env.COMPANION_PROTOCOL ?? 'http').toLowerCase() as 'http' | 'https';

    const publicHost = process.env.COMPANION_HOST ?? `localhost:${port}`;
    const secret = process.env.COMPANION_SECRET ?? '';
    const healthCheckKey = process.env.HEALTH_CHECK_KEY;
    const filePath = process.env.COMPANION_FILE_PATH ?? '/tmp/';
    const redisUrl = process.env.REDIS_URL;

    const corsOrigins = parseCsv(process.env.CORS_ALLOWED_ORIGINS);
    const brands = process.env.COMPANION_BRANDS ?? 'default';
    const brandConfigs = parseBrandConfigs(brands);

    const s3Defaults = {
        bucket: process.env.AWS_BUCKET_NAME,
        region: process.env.AWS_REGION,
        accessKey: process.env.AWS_ACCESS_KEY_ID,
        secretKey: process.env.AWS_SECRET_ACCESS_KEY,
        useAccelerateEndpoint: process.env.COMPANION_AWS_ACCELERATE_ENDPOINT === 'true',
    };

    const providerDefaults = {
        google: {
            clientId: process.env.COMPANION_GOOGLE_CLIENT_ID,
            clientSecret: process.env.COMPANION_GOOGLE_CLIENT_SECRET,
            driveApiKey: process.env.COMPANION_GOOGLE_DRIVE_API_KEY,
            photosApiKey: process.env.COMPANION_GOOGLE_PHOTOS_API_KEY,
            appId: process.env.COMPANION_GOOGLE_APP_ID,
        },
        dropbox: {
            key: process.env.COMPANION_DROPBOX_KEY,
            secret: process.env.COMPANION_DROPBOX_SECRET,
        },
        facebook: {
            key: process.env.COMPANION_FACEBOOK_KEY,
            secret: process.env.COMPANION_FACEBOOK_SECRET,
        },
        instagram: {
            key: process.env.COMPANION_INSTAGRAM_KEY,
            secret: process.env.COMPANION_INSTAGRAM_SECRET,
        },
        onedrive: {
            key: process.env.COMPANION_ONEDRIVE_KEY,
            secret: process.env.COMPANION_ONEDRIVE_SECRET,
        },
        box: {
            key: process.env.COMPANION_BOX_KEY,
            secret: process.env.COMPANION_BOX_SECRET,
        },
        unsplash: {
            key: process.env.COMPANION_UNSPLASH_KEY,
            secret: process.env.COMPANION_UNSPLASH_SECRET,
        },
        zoom: {
            key: process.env.COMPANION_ZOOM_KEY,
            secret: process.env.COMPANION_ZOOM_SECRET,
        },
    };

    return envSchema.parse({
        port,
        host,
        protocol,
        publicHost,
        secret,
        healthCheckKey,
        filePath,
        redisUrl,
        corsOrigins,
        brands,
        publicBackendUrl: process.env.PUBLIC_BACKEND_URL,
        publicUploadUrl: process.env.PUBLIC_UPLOAD_URL,
        publicFoldersUrl: process.env.PUBLIC_FOLDERS_URL,
        s3Defaults,
        providerDefaults,
        brandConfigs,
    });
};

/**
 * Validated environment configuration
 */
export const env = deriveEnv();

export type { EnvConfig };
