import type { S3Client } from '@aws-sdk/client-s3';

/**
 * Brand configuration types for multi-brand support
 */

export interface BrandProviderConfig {
    key: string;
    secret: string;
}

export interface BrandProviderInputConfig {
    key?: string;
    secret?: string;
}

export interface BrandGoogleProviderConfig {
    clientId: string;
    clientSecret?: string;
    driveApiKey?: string;
    photosApiKey?: string;
    appId?: string;
}

export interface BrandGoogleProviderInputConfig {
    // Preferred keys
    clientId?: string;
    clientSecret?: string;
    driveApiKey?: string;
    photosApiKey?: string;
    appId?: string;
    // Legacy aliases kept for backwards compatibility
    key?: string;
    secret?: string;
    apiKey?: string;
}

export interface BrandS3Config {
    bucket: string;
    region: string;
    accessKey?: string;
    secretKey?: string;
    useAccelerateEndpoint?: boolean;
    client?: S3Client;
}

export interface BrandConfigJSON {
    /** Human-readable name shown in the UI. Falls back to the slug when omitted. */
    displayName?: string;
    /** Brand's registrable domain (e.g. "abeduls.com"). Required when auth.url is set:
     *  drives the per-brand CORS regex on /api/uppy/* and documents the cookie scope. */
    rootDomain?: string;
    /** Preferred: auth configuration block */
    auth?: {
        url?: string;
        cookieName?: string;
    };
    /** Preferred: public URLs configuration block */
    public?: {
        backendUrl?: string;
        uploadUrl?: string;
        foldersUrl?: string;
        /** Where to 302 the user when their cookie is missing. Optional —
         *  if absent, Companion renders a static error page. */
        loginUrl?: string;
    };
    /** Legacy fields (kept for backwards compatibility) */
    authUrl?: string;
    authCookieName?: string;
    publicBackendUrl?: string;
    publicUploadUrl?: string;
    companionUrl?: string; // [NEW] Override for proxy URL
    corsOrigins?: string[];
    uploadUrls?: string[];
    s3?: {
        bucket?: string;
        region?: string;
        accessKey?: string;
        secretKey?: string;
        useAccelerateEndpoint?: boolean;
    };
    providers?: {
        google?: BrandGoogleProviderInputConfig;
        dropbox?: BrandProviderInputConfig;
        facebook?: BrandProviderInputConfig;
        instagram?: BrandProviderInputConfig;
        onedrive?: BrandProviderInputConfig;
        box?: BrandProviderInputConfig;
        unsplash?: BrandProviderInputConfig;
        zoom?: BrandProviderInputConfig;
    };
    /** Comma-separated list of enabled Uppy plugins (case-insensitive) */
    enabledPlugins?: string;
}

export interface Brand {
    /** Unique identifier for the brand (slug) */
    id: string;

    /** Display name for the brand */
    displayName: string;

    /** Brand's registrable domain (e.g. "abeduls.com"). null when auth.url is null. */
    rootDomain: string | null;

    /** [NEW] Explicit public URL for Companion (e.g. for proxies) */
    companionUrl?: string;

    /** Auth configuration */
    auth: {
        /** URL to validate authentication tokens. If null, auth is disabled */
        url: string | null;
        /** Cookie name for storing auth token */
        cookieName: string;
    };

    /** S3 configuration for file uploads */
    s3: BrandS3Config;

    /** OAuth provider configurations */
    providers: {
        google?: BrandGoogleProviderConfig;
        dropbox?: BrandProviderConfig;
        facebook?: BrandProviderConfig;
        instagram?: BrandProviderConfig;
        onedrive?: BrandProviderConfig;
        box?: BrandProviderConfig;
        unsplash?: BrandProviderConfig;
        zoom?: BrandProviderConfig;
    };

    /** Allowed CORS origins for this brand */
    corsOrigins: (string | RegExp)[];

    /** Allowed upload URLs */
    uploadUrls: string[];

    /** Secret for companion encryption */
    secret: string;

    /** Public URLs */
    public: {
        /** Public Backend URL for saving files (Laravel/API) */
        backendUrl: string;
        /** Public Upload URL override per brand */
        uploadUrl: string;
        /** Folders API endpoint */
        foldersUrl?: string;
        /** Where Companion 302's the user when their cookie is missing. */
        loginUrl?: string;
    };

    /** Companion server settings */
    server: {
        host: string;
        protocol: 'http' | 'https';
        path: string;
    };

    /** File storage path */
    filePath: string;

    /** Enabled Uppy plugins for this brand */
    enabledPlugins: string[];
}

export interface BrandRegistry {
    brands: Map<string, Brand>;
    defaultBrand: Brand | null;
}
