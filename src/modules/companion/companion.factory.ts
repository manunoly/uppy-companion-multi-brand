import express from 'express';
import * as companion from '@uppy/companion';
import type { Brand } from '../brand/brand.types.js';
import type { CompanionOptions, CompanionProviderOptions } from './companion.types.js';
import type { AppRequest } from '../../core/types/express.js';
import { buildS3Key } from './s3/s3.key-builder.js';
import { logger } from '../../lib/logger.js';

const DEFAULT_FILE_PATH = '/tmp/';

/**
 * Builds provider options from brand configuration
 */
const buildProviderOptions = (brand: Brand): Record<string, CompanionProviderOptions> => {
    const providers: Record<string, CompanionProviderOptions> = {};

    if (brand.providers.google) {
        providers.drive = {
            key: brand.providers.google.clientId,
            secret: brand.providers.google.clientSecret ?? '',
            apiKeyDrive: brand.providers.google.driveApiKey,
            apiKeyPhotos: brand.providers.google.photosApiKey,
            appId: brand.providers.google.appId,
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

    // `companionUrl` is mandatory on the abeduls3-aligned Brand contract (D2) —
    // it is always the source of truth for the public domain used in OAuth
    // redirect_uri generation. This is what eliminates the old `/default/`
    // segment mis-derivation hack (spec D4).
    const oauthUrl = parseCompanionUrl(brand);

    // We attach it to every provider so Companion uses it for redirect_uri generation
    Object.keys(providers).forEach((key) => {
        providers[key].oauthDomain = oauthUrl.host;
        providers[key].oauthProtocol = oauthUrl.protocol;
        providers[key].oauthPath = oauthUrl.path;
    });

    return providers;
};

interface ParsedCompanionUrl {
    host: string;
    protocol: 'http' | 'https';
    path: string;
}

/**
 * Parses `brand.companionUrl` into Companion's server-options shape. Falls
 * back to a safe default when the URL is empty/malformed — in practice this
 * only happens for the non-servable placeholder registry entries (abe,
 * picaboo today), which never actually get a companion instance created
 * (`createBrandRegistry` only resolves servable slugs).
 */
const parseCompanionUrl = (brand: Brand): ParsedCompanionUrl => {
    try {
        const url = new URL(brand.companionUrl);
        return {
            host: url.host,
            protocol: url.protocol.replace(':', '') as 'http' | 'https',
            path: url.pathname.replace(/\/$/, '') || '/',
        };
    } catch (err) {
        logger.error({ err, brand: brand.slug, companionUrl: brand.companionUrl }, '[companion] Invalid or missing companionUrl for brand');
        return { host: 'localhost', protocol: 'http', path: `/${brand.slug}` };
    }
};

/**
 * Builds companion options for a brand
 */
export const buildCompanionOptions = (brand: Brand, filePath: string = DEFAULT_FILE_PATH): CompanionOptions => {
    const serverOptions = parseCompanionUrl(brand);

    const options: CompanionOptions = {
        providerOptions: buildProviderOptions(brand),
        server: serverOptions,
        filePath,
        secret: brand.secret,
        // TODO(Fase 4.3, D9): `uploadUrls`/`allowLocalUrls` are still the
        // unhardened legacy defaults. Fase 4.3 derives `uploadUrls` from
        // `brand.s3.bucket`/`companionUrl`/`domains` and sets
        // `allowLocalUrls: env.protocol === 'http'` + `validHosts` (closes H1/H2/H7).
        uploadUrls: ['*'],
        corsOrigins: brand.domains.map((domain) => `https://${domain}`),
        metrics: false,
        allowLocalUrls: true,
        enableGooglePickerEndpoint: true,
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
export const createCompanionForBrand = (brand: Brand, filePath: string = DEFAULT_FILE_PATH): CompanionInstance => {
    const options = buildCompanionOptions(brand, filePath);

    const { app: companionApp } = companion.app(options as Parameters<typeof companion.app>[0]);

    // Create a router that injects brand into request
    const router = express.Router();

    router.use((req, _res, next) => {
        (req as AppRequest).brand = brand;
        next();
    });

    router.use(companionApp);

    logger.info({ brand: brand.slug }, '[companion] Created instance for brand');

    return {
        brand,
        app: router as unknown as express.Express,
    };
};

/**
 * Attaches Companion websocket support to server
 */
export const attachCompanionSocket = companion.socket;
