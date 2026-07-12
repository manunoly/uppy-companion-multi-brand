import express from 'express';
import * as companion from '@uppy/companion';
import type { Brand, CompanionProviders, EdoUploadPlugin } from '../brand/brand.types.js';
import type { CompanionOptions, CompanionProviderOptions } from './companion.types.js';
import type { AppRequest } from '../../core/types/express.js';
import { buildS3Key } from './s3/s3.key-builder.js';
import { logger } from '../../lib/logger.js';

const DEFAULT_FILE_PATH = '/tmp/';

/**
 * Environment inputs the factory needs but that don't belong on `Brand`
 * itself (brand-independent, process-wide). Callers pass their `EnvConfig`
 * (structurally compatible) — see `server.ts#createServer` and
 * `test-utils/http.ts#createTestApp`.
 */
export interface CompanionFactoryEnv {
    readonly filePath?: string;
    readonly protocol: 'http' | 'https';
}

/**
 * Maps each typed upload plugin (D2's `EdoUploadPlugin`) to the Companion
 * provider key it activates. `Url` isn't an OAuth provider (it's Companion's
 * built-in "import from a URL" endpoint), so it maps to `null`. Both Google
 * picker variants share the same OAuth backend (Companion's `drive`
 * provider handles both Drive files and Photos via `apiKeyDrive`/
 * `apiKeyPhotos`).
 *
 * Task 4.3: providers are DERIVED from `brand.upload.plugins`, not merely
 * from which credentials happen to be configured — a brand that never
 * enabled a plugin never gets its OAuth callback wired, shrinking the
 * per-brand attack surface. `CompanionProviders` also declares
 * instagram/onedrive/box/unsplash/zoom for structural completeness, but no
 * `EdoUploadPlugin` value maps to them today, so they are intentionally not
 * wired here.
 */
const PLUGIN_PROVIDER_KEY: Record<EdoUploadPlugin, keyof CompanionProviders | null> = {
    Facebook: 'facebook',
    Dropbox: 'dropbox',
    GoogleDrivePicker: 'google',
    GooglePhotosPicker: 'google',
    Url: null,
};

/**
 * Builds provider options from brand configuration, restricted to the
 * providers backing an enabled `brand.upload.plugins` entry (Task 4.3).
 */
const buildProviderOptions = (brand: Brand): Record<string, CompanionProviderOptions> => {
    const providers: Record<string, CompanionProviderOptions> = {};
    const enabledProviderKeys = new Set(
        brand.upload.plugins
            .map((plugin) => PLUGIN_PROVIDER_KEY[plugin])
            .filter((key): key is keyof CompanionProviders => key !== null),
    );

    if (enabledProviderKeys.has('google') && brand.providers.google) {
        providers.drive = {
            key: brand.providers.google.clientId,
            secret: brand.providers.google.clientSecret ?? '',
            apiKeyDrive: brand.providers.google.driveApiKey,
            apiKeyPhotos: brand.providers.google.photosApiKey,
            appId: brand.providers.google.appId,
        };
    }

    if (enabledProviderKeys.has('dropbox') && brand.providers.dropbox) {
        providers.dropbox = {
            key: brand.providers.dropbox.key,
            secret: brand.providers.dropbox.secret,
        };
    }

    if (enabledProviderKeys.has('facebook') && brand.providers.facebook) {
        providers.facebook = {
            key: brand.providers.facebook.key,
            secret: brand.providers.facebook.secret,
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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `validHosts` (options.server.validHosts) is Companion's allowlist for the
 * OAuth `redirect_uri` handoff (`oauth-redirect.js`:
 * `hasMatch(handlerHostName, options.server.validHosts)`) — closes H7.
 * Derived from this Companion instance's own public host(s): the brand's
 * `companionHosts` (code-only, never overridable) plus the host parsed out
 * of `companionUrl` (the source of truth for the public origin, D4/D9), so a
 * forged `state` param can never redirect the OAuth callback to an
 * arbitrary attacker-controlled host.
 *
 * Security review BAJO-2: Companion's own `hasMatch` (server/helpers/
 * utils.js) does `value === i || new RegExp(i).test(value)` — UNANCHORED,
 * and with no escaping of its own. Handing it a plain hostname like
 * `companion.example.com` lets the unescaped `.` match ANY character, and
 * being unanchored, lets the pattern match as a mere SUBSTRING of a longer,
 * attacker-influenced `handlerHostName` (e.g.
 * `evil-companion.example.com.attacker.test` would satisfy an unanchored
 * `new RegExp('companion.example.com').test(...)`). Every entry is anchored
 * (`^...$`) and regex-escaped here so `hasMatch` can only ever match the
 * EXACT host — same allowlist, strictly narrower matching.
 */
const buildValidHosts = (brand: Brand): string[] => {
    const hosts = new Set<string>(brand.companionHosts);
    try {
        hosts.add(new URL(brand.companionUrl).host);
    } catch {
        // Malformed companionUrl is already logged by parseCompanionUrl.
    }
    return Array.from(hosts, (host) => `^${escapeRegExp(host)}$`);
};

/**
 * `uploadUrls` restricts which destination URLs Companion's non-S3 upload
 * protocols may target (`Uploader.js#validateUrl` — S3 uploads are exempt,
 * their destination comes from `brand.s3`, not client input). It must never
 * be `['*']` (D9, closes H1/H2): that would let an authenticated client
 * point Companion's upload machinery at an arbitrary origin. Derived from
 * this Companion instance's own public origin(s) (`companionUrl` +
 * `companionHosts`) and the brand's own S3 bucket (virtual-hosted-style
 * endpoint), so only well-known, brand-owned destinations are allowed.
 * Companion matches each entry via `new RegExp(entry).test(url)` (or exact
 * string equality) — see `server/helpers/utils.js#hasMatch` — hence the
 * regex-escaped, start-anchored patterns below.
 */
const buildUploadUrls = (brand: Brand): string[] => {
    const origins = new Set<string>();
    try {
        origins.add(new URL(brand.companionUrl).origin);
    } catch {
        // Malformed companionUrl is already logged by parseCompanionUrl.
    }
    for (const host of brand.companionHosts) {
        origins.add(`https://${host}`);
    }

    const patterns = Array.from(origins, (origin) => `^${escapeRegExp(origin)}/`);

    if (brand.s3.bucket && brand.s3.region) {
        const s3Origin = `https://${brand.s3.bucket}.s3.${brand.s3.region}.amazonaws.com/`;
        patterns.push(`^${escapeRegExp(s3Origin)}`);
    }

    return patterns;
};

interface ParsedCompanionUrl {
    host: string;
    protocol: 'http' | 'https';
    path?: string;
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
        // @uppy/companion's validateConfig throws on the literal string '/'
        // (github.com/transloadit/uppy/issues/4271) — root-path deployments
        // (the common case) must leave `path` unset, not '/'.
        const path = url.pathname.replace(/\/$/, '');
        return {
            host: url.host,
            protocol: url.protocol.replace(':', '') as 'http' | 'https',
            path: path || undefined,
        };
    } catch (err) {
        logger.error({ err, brand: brand.slug, companionUrl: brand.companionUrl }, '[companion] Invalid or missing companionUrl for brand');
        return { host: 'localhost', protocol: 'http', path: `/${brand.slug}` };
    }
};

/**
 * Builds companion options for a brand.
 *
 * `env` supplies the process-wide, brand-independent inputs `allowLocalUrls`
 * needs (Task 4.3, D9): `allowLocalUrls: env.protocol === 'http'` so local/
 * private-network URLs are only ever accepted in dev, never in a `https`
 * (prod) deployment — this used to be hardcoded `true` regardless of
 * environment (closes H1/H2 together with `uploadUrls`/`validHosts` below).
 */
export const buildCompanionOptions = (brand: Brand, env: CompanionFactoryEnv): CompanionOptions => {
    const serverOptions = parseCompanionUrl(brand);

    const options: CompanionOptions = {
        providerOptions: buildProviderOptions(brand),
        server: { ...serverOptions, validHosts: buildValidHosts(brand) },
        filePath: env.filePath ?? DEFAULT_FILE_PATH,
        secret: brand.secret,
        uploadUrls: buildUploadUrls(brand),
        corsOrigins: brand.domains.map((domain) => `https://${domain}`),
        metrics: false,
        allowLocalUrls: env.protocol === 'http',
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
export const createCompanionForBrand = (brand: Brand, env: CompanionFactoryEnv): CompanionInstance => {
    const options = buildCompanionOptions(brand, env);

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
