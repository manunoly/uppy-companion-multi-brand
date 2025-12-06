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

    return providers;
};

/**
 * Builds companion options for a brand
 */
export const buildCompanionOptions = (brand: Brand): CompanionOptions => {
    const options: CompanionOptions = {
        providerOptions: buildProviderOptions(brand),
        server: {
            host: brand.server.host,
            protocol: brand.server.protocol,
            path: brand.server.path,
        },
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
