import type {
    Brand,
    BrandRegistry,
    BrandS3Config,
    BrandProviderConfig,
    BrandProviderInputConfig,
    BrandConfigJSON,
    BrandGoogleProviderInputConfig,
    BrandGoogleProviderConfig
} from './brand.types.js';
import { getS3Client } from '../../lib/aws/s3Client.js';
import { normalizeBrandSlug } from './brand.utils.js';

interface PublicDefaults {
    backendUrl?: string;
    uploadUrl?: string;
    foldersUrl?: string;
}

interface S3Defaults {
    bucket?: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    useAccelerateEndpoint?: boolean;
}

interface ProviderDefaults {
    google?: BrandGoogleProviderInputConfig;
    dropbox?: BrandProviderInputConfig;
    facebook?: BrandProviderInputConfig;
    instagram?: BrandProviderInputConfig;
    onedrive?: BrandProviderInputConfig;
    box?: BrandProviderInputConfig;
    unsplash?: BrandProviderInputConfig;
    zoom?: BrandProviderInputConfig;
}

export interface CreateBrandRegistryOptions {
    corsOrigins: (string | RegExp)[];
    secret: string;
    filePath: string;
    host: string;
    protocol: 'http' | 'https';
    brands: string;
    brandConfigs: Record<string, BrandConfigJSON>;
    publicDefaults: PublicDefaults;
    s3Defaults: S3Defaults;
    providerDefaults: ProviderDefaults;
}

export { normalizeBrandSlug };

const createProviderConfig = (
    providerConfig: BrandProviderInputConfig | undefined,
    globalConfig: BrandProviderInputConfig | undefined,
    options: { allowKeyOnly?: boolean } = {}
): BrandProviderConfig | undefined => {
    const allowKeyOnly = options.allowKeyOnly ?? false;

    if (providerConfig?.key && (providerConfig.secret || allowKeyOnly)) {
        return {
            key: providerConfig.key,
            secret: providerConfig.secret ?? '',
        };
    }

    if (globalConfig?.key && (globalConfig.secret || allowKeyOnly)) {
        return {
            key: globalConfig.key,
            secret: globalConfig.secret ?? '',
        };
    }

    return undefined;
};

const createGoogleProviderConfig = (
    providerConfig: BrandGoogleProviderInputConfig | undefined,
    globalConfig: BrandGoogleProviderInputConfig | undefined
): BrandGoogleProviderConfig | undefined => {
    const clientId = providerConfig?.clientId
        ?? providerConfig?.key
        ?? globalConfig?.clientId
        ?? globalConfig?.key;

    if (!clientId) return undefined;

    const clientSecret = providerConfig?.clientSecret
        ?? providerConfig?.secret
        ?? globalConfig?.clientSecret
        ?? globalConfig?.secret
        ?? '';

    const driveApiKey = providerConfig?.driveApiKey
        ?? providerConfig?.apiKey
        ?? globalConfig?.driveApiKey
        ?? globalConfig?.apiKey;
    const photosApiKey = providerConfig?.photosApiKey
        ?? providerConfig?.apiKey
        ?? globalConfig?.photosApiKey
        ?? globalConfig?.apiKey;
    const appId = providerConfig?.appId ?? globalConfig?.appId;

    return {
        clientId,
        clientSecret,
        driveApiKey,
        photosApiKey,
        appId,
    };
};

const createS3Config = (
    s3Config: BrandConfigJSON['s3'] | undefined,
    defaults: S3Defaults
): BrandS3Config => {
    const config: BrandS3Config = {
        bucket: s3Config?.bucket ?? defaults.bucket ?? '',
        region: s3Config?.region ?? defaults.region ?? '',
        accessKey: s3Config?.accessKey ?? defaults.accessKey ?? undefined,
        secretKey: s3Config?.secretKey ?? defaults.secretKey ?? undefined,
        useAccelerateEndpoint: s3Config?.useAccelerateEndpoint ?? defaults.useAccelerateEndpoint ?? false,
    };

    if (config.region) {
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
 * Valid Uppy plugin names (case-insensitive mapping)
 */
const VALID_PLUGINS: Record<string, string> = {
    'url': 'Url',
    'googledrivepicker': 'GoogleDrivePicker',
    'googlephotospicker': 'GooglePhotosPicker',
    'googledrive': 'GoogleDrive',
    'googlephotos': 'GooglePhotos',
    'dropbox': 'Dropbox',
    'facebook': 'Facebook',
    'instagram': 'Instagram',
    'onedrive': 'OneDrive',
    'box': 'Box',
    'unsplash': 'Unsplash',
    'zoom': 'Zoom',
};

/**
 * Parses enabled plugins from comma-separated string
 * Returns normalized plugin names (case-insensitive input)
 */
const parseEnabledPlugins = (enabledPlugins: string | undefined): string[] => {
    if (!enabledPlugins) return [];

    return enabledPlugins
        .split(',')
        .map(p => p.trim().toLowerCase())
        .filter(p => p.length > 0)
        .map(p => VALID_PLUGINS[p])
        .filter((p): p is string => p !== undefined);
};

/**
 * Creates a brand descriptor from injected defaults and optional pre-validated
 * brand-specific configuration.
 */
export const createBrand = (
    slug: string,
    defaults: CreateBrandRegistryOptions
): Brand => {
    const mountPath = `/${slug}`;
    const config = defaults.brandConfigs[slug] ?? {};

    const serverHost = defaults.host;
    const serverProtocol = defaults.protocol;

    return {
        id: slug,
        displayName: slug, // JSON config could add displayName if needed, for now using slug

        // Proxy Support
        companionUrl: config.companionUrl,

        // Auth
        auth: {
            url: config.auth?.url ?? config.authUrl ?? null,
            cookieName: config.auth?.cookieName ?? config.authCookieName ?? 'session',
        },

        s3: createS3Config(config.s3, defaults.s3Defaults),

        providers: {
            google: createGoogleProviderConfig(config.providers?.google, defaults.providerDefaults.google),
            dropbox: createProviderConfig(config.providers?.dropbox, defaults.providerDefaults.dropbox),
            facebook: createProviderConfig(config.providers?.facebook, defaults.providerDefaults.facebook),
            instagram: createProviderConfig(config.providers?.instagram, defaults.providerDefaults.instagram),
            onedrive: createProviderConfig(config.providers?.onedrive, defaults.providerDefaults.onedrive),
            box: createProviderConfig(config.providers?.box, defaults.providerDefaults.box),
            unsplash: createProviderConfig(config.providers?.unsplash, defaults.providerDefaults.unsplash),
            zoom: createProviderConfig(config.providers?.zoom, defaults.providerDefaults.zoom),
        },

        corsOrigins: parseCorsOrigins(config.corsOrigins, defaults.corsOrigins),
        uploadUrls: config.uploadUrls ?? ['*'],

        public: (() => {
            const backendUrl = config.public?.backendUrl
                ?? config.publicBackendUrl
                ?? defaults.publicDefaults.backendUrl
                ?? 'http://localhost';

            const uploadUrl = config.public?.uploadUrl
                ?? config.publicUploadUrl
                ?? defaults.publicDefaults.uploadUrl
                ?? `${backendUrl}/api/frame/contents/upload/public`;

            const foldersUrl = config.public?.foldersUrl
                ?? defaults.publicDefaults.foldersUrl;

            return {
                backendUrl,
                uploadUrl,
                foldersUrl,
            };
        })(),

        secret: defaults.secret,
        server: {
            host: serverHost,
            protocol: serverProtocol,
            path: mountPath,
        },
        filePath: defaults.filePath,
        enabledPlugins: parseEnabledPlugins(config.enabledPlugins),
    };
};

export const createBrandRegistry = (defaults: CreateBrandRegistryOptions): BrandRegistry => {
    const rawBrandList = defaults.brands;
    const slugs = [...new Set(
        rawBrandList.split(',').map(normalizeBrandSlug).filter(Boolean)
    )];

    if (slugs.length === 0) {
        throw new Error('No brands configured: options.brands is empty (typically sourced from COMPANION_BRANDS).');
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
