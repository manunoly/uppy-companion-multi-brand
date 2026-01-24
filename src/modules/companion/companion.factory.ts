import express from 'express';
import * as companion from '@uppy/companion';
import type { Brand } from '../brand/brand.types.js';
import type { CompanionOptions, CompanionProviderOptions } from './companion.types.js';
import type { AppRequest } from '../../core/types/express.js';
import { buildS3Key } from './s3/s3.key-builder.js';

/**
 * Builds provider options from brand configuration
 */
const buildProviderOptions = (brand: Brand): Record<string, CompanionProviderOptions> => {
    const providers: Record<string, CompanionProviderOptions> = {};

    if (brand.providers.google) {
        providers.drive = {
            key: brand.providers.google.key,
            secret: brand.providers.google.secret,
        };
    }

    if (brand.providers.dropbox) {
        providers.dropbox = {
            key: brand.providers.dropbox.key,
            secret: brand.providers.dropbox.secret,
        };
    }

    if (brand.providers.facebook) {
        providers.facebook = {
            key: brand.providers.facebook.key,
            secret: brand.providers.facebook.secret,
        };
    }

    if (brand.providers.instagram) {
        providers.instagram = {
            key: brand.providers.instagram.key,
            secret: brand.providers.instagram.secret,
        };
    }

    if (brand.providers.onedrive) {
        providers.onedrive = {
            key: brand.providers.onedrive.key,
            secret: brand.providers.onedrive.secret,
        };
    }

    if (brand.providers.box) {
        providers.box = {
            key: brand.providers.box.key,
            secret: brand.providers.box.secret,
        };
    }

    if (brand.providers.unsplash) {
        providers.unsplash = {
            key: brand.providers.unsplash.key,
            secret: brand.providers.unsplash.secret,
        };
    }

    if (brand.providers.zoom) {
        providers.zoom = {
            key: brand.providers.zoom.key,
            secret: brand.providers.zoom.secret,
        };
    }

    // [NEW] Use companionUrl to determine the public domain for OAuth redirects
    // This fixes the issue where implicit path construction adds extra segments like /default/
    const oauthDomain = brand.companionUrl
        ? new URL(brand.companionUrl).host
        : brand.server.host;
    const oauthPath = brand.companionUrl
        ? new URL(brand.companionUrl).pathname.replace(/\/$/, '') || '/'
        : brand.server.path;

    // We attach it to every provider so Companion uses it for redirect_uri generation
    Object.keys(providers).forEach((key) => {
        providers[key].oauthDomain = oauthDomain;
        providers[key].oauthProtocol = brand.companionUrl
            ? (new URL(brand.companionUrl).protocol.replace(':', '') as 'http' | 'https')
            : brand.server.protocol;
        providers[key].oauthPath = oauthPath;
    });

    return providers;
};

/**
 * Builds companion options for a brand
 */
export const buildCompanionOptions = (brand: Brand): CompanionOptions => {
    let serverOptions = {
        host: brand.server.host,
        protocol: brand.server.protocol,
        path: brand.server.path,
    };

    // [NEW] Use companionUrl to override server settings for public URLs (e.g. Proxy)
    if (brand.companionUrl) {
        try {
            const url = new URL(brand.companionUrl);
            serverOptions = {
                host: url.host, // includes port if present
                protocol: url.protocol.replace(':', '') as 'http' | 'https',
                path: url.pathname.replace(/\/$/, ''), // remove trailing slash
            };
        } catch (err) {
            console.error(`[companion] Invalid companionUrl for brand ${brand.id}:`, brand.companionUrl);
        }
    }

    const options: CompanionOptions = {
        providerOptions: buildProviderOptions(brand),
        server: serverOptions,
        filePath: brand.filePath,
        secret: brand.secret,
        uploadUrls: brand.uploadUrls,
        corsOrigins: brand.corsOrigins,
        metrics: false,
        allowLocalUrls: true, // Allow uploads to localhost
    };

    // Add S3 config if available
    if (brand.s3.bucket && brand.s3.region) {
        options.s3 = {
            bucket: brand.s3.bucket,
            region: brand.s3.region,
            key: brand.s3.accessKey,
            secret: brand.s3.secretKey,
            awsClient: brand.s3.client,
            useAccelerateEndpoint: brand.s3.useAccelerateEndpoint,
            getKey: (req, filename, metadata) => buildS3Key({ req: req as AppRequest, filename, metadata }),
        };
    }

    return options;
};

export interface CompanionInstance {
    brand: Brand;
    app: express.Express;
}

/**
 * Creates a Companion instance for a brand
 */
export const createCompanionForBrand = (brand: Brand): CompanionInstance => {
    const options = buildCompanionOptions(brand);

    if (brand.id === 'abeduls') {
        console.log('[DEBUG] Companion Factory Options for Abeduls:', JSON.stringify(options.providerOptions?.dropbox, null, 2));
    }

    const { app: companionApp } = companion.app(options as Parameters<typeof companion.app>[0]);

    // Create a router that injects brand into request
    const router = express.Router();

    router.use((req, _res, next) => {
        (req as AppRequest).brand = brand;
        next();
    });

    router.use(companionApp);

    console.log(`[companion] Created instance for brand "${brand.id}"`);

    return {
        brand,
        app: router as unknown as express.Express,
    };
};

/**
 * Attaches Companion websocket support to server
 */
export const attachCompanionSocket = companion.socket;
