import type { S3Client } from '@aws-sdk/client-s3';

/**
 * Brand configuration types for multi-brand support
 */

export interface BrandProviderConfig {
    key: string;
    secret: string;
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
    authUrl?: string;
    authCookieName?: string;
    projectCookieName?: string;
    publicBackendUrl?: string;
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
        google?: BrandProviderConfig;
        dropbox?: BrandProviderConfig;
        facebook?: BrandProviderConfig;
        instagram?: BrandProviderConfig;
        onedrive?: BrandProviderConfig;
        box?: BrandProviderConfig;
        unsplash?: BrandProviderConfig;
        zoom?: BrandProviderConfig;
    };
}

export interface Brand {
    /** Unique identifier for the brand (slug) */
    id: string;

    /** Display name for the brand */
    displayName: string;

    /** URL to validate authentication tokens. If null, auth is disabled */
    authUrl: string | null;

    /** Cookie name for storing auth token */
    authCookieName: string;

    /** Cookie name for storing project ID */
    projectCookieName: string;

    /** S3 configuration for file uploads */
    s3: BrandS3Config;

    /** OAuth provider configurations */
    providers: {
        google?: BrandProviderConfig;
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

    /** Public Backend URL for saving files (Laravel/API) */
    publicBackendUrl: string;

    /** Companion server settings */
    server: {
        host: string;
        protocol: 'http' | 'https';
        path: string;
    };

    /** File storage path */
    filePath: string;
}

export interface BrandRegistry {
    brands: Map<string, Brand>;
    defaultBrand: Brand | null;
}
