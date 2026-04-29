import express from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { timingSafeEqual } from 'node:crypto';

import { env } from './config/index.js';
import type { AppRequest } from './core/types/express.js';
import {
    createBrandRegistry,
    getAllBrands,
    type BrandRegistry
} from './modules/brand/index.js';
import { attachUser } from './modules/auth/index.js';
import {
    createCompanionForBrand,
    attachCompanionSocket,
    serveUppyPage,
    serveUppyModalJs,
    apiRouter,
    type CompanionInstance
} from './modules/companion/index.js';

interface ServerResult {
    app: express.Express;
    brandRegistry: BrandRegistry;
    companionInstances: CompanionInstance[];
}

// Constant-time comparison to avoid timing attacks on HEALTH_CHECK_KEY.
const safeEqual = (a: string, b: string): boolean => {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
};

/**
 * Creates and configures the Express application
 */
export const createServer = (): ServerResult => {
    const app = express();

    // Basic middleware
    // Trust proxy for proper IP detection (Standard for Railway/AWS/Heroku)
    app.set('trust proxy', 1);

    // Basic middleware
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(cookieParser());

    // Session middleware is mounted per-brand below (not globally) so health
    // checks, /api/brands, and 404s don't create empty sessions or set cookies.
    // `saveUninitialized: true` is intentional: Companion's OAuth flow requires
    // a persisted session to exist before the redirect to the provider.
    const sessionMiddleware = session({
        name: 'companion.sid',
        secret: env.secret,
        resave: false,
        saveUninitialized: true,
        proxy: true, // Crucial for secure cookies behind reverse proxies like Railway
        cookie: {
            secure: env.protocol === 'https',
            sameSite: env.protocol === 'https' ? 'none' : 'lax',
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000 // 1 day
        }
    });

    // Create brand registry
    const brandRegistry: BrandRegistry = createBrandRegistry({
        corsOrigins: env.corsOrigins,
        secret: env.secret,
        filePath: env.filePath,
        host: env.publicHost,
        protocol: env.protocol,
        brands: env.brands,
        brandConfigs: env.brandConfigs,
        publicDefaults: {
            backendUrl: env.publicBackendUrl,
            uploadUrl: env.publicUploadUrl,
            foldersUrl: env.publicFoldersUrl,
        },
        s3Defaults: env.s3Defaults,
        providerDefaults: env.providerDefaults,
    });

    // Create companion instances for each brand
    const companionInstances: CompanionInstance[] = [];
    for (const brand of brandRegistry.brands.values()) {
        const instance = createCompanionForBrand(brand);
        companionInstances.push(instance);
    }

    // Health check (no auth required)
    app.get('/api/healthz', (_req, res) => {
        res.json({ status: 'ok', timestamp: Date.now() });
    });

    // List all brands (detailed info requires HEALTH_CHECK_KEY)
    app.get('/api/brands', (req, res) => {
        const queryKey = typeof req.query.key === 'string' ? req.query.key : null;
        const healthCheckKey = env.healthCheckKey;
        const showDetails = !!(healthCheckKey && queryKey && safeEqual(queryKey, healthCheckKey));

        /**
         * Masks a secret showing only last 4 characters
         * Example: "sk_live_abc123xyz789" -> "****...9789"
         */
        const maskSecret = (value: string | undefined | null): string | null => {
            if (!value) return null;
            if (value.length <= 4) return '****';
            return `****...${value.slice(-4)}`;
        };

        const brands = getAllBrands(brandRegistry).map(brand => {
            // Basic info (always shown)
            const basicInfo = {
                id: brand.id,
                displayName: brand.displayName,
            };

            // Return only basic info if key doesn't match
            if (!showDetails) {
                return basicInfo;
            }

            // Detailed info (only when key matches)
            return {
                ...basicInfo,
                // URLs (safe to show)
                urls: {
                    companion: brand.companionUrl ?? `${brand.server.protocol}://${brand.server.host}${brand.server.path}`,
                    auth: brand.auth.url,
                    backendPublic: brand.public.backendUrl,
                    uploadPublic: brand.public.uploadUrl,
                    foldersPublic: brand.public.foldersUrl ?? null,
                },
                // Auth config
                auth: {
                    url: brand.auth.url,
                    cookieName: brand.auth.cookieName,
                },
                // S3 config (masked secrets)
                s3: {
                    bucket: brand.s3.bucket,
                    region: brand.s3.region,
                    accessKey: maskSecret(brand.s3.accessKey),
                    secretKey: maskSecret(brand.s3.secretKey),
                    useAccelerateEndpoint: brand.s3.useAccelerateEndpoint ?? false,
                    clientConfigured: !!brand.s3.client,
                },
                // Providers (masked secrets)
                providers: {
                    google: brand.providers.google ? {
                        clientId: brand.providers.google.clientId,
                        clientSecret: maskSecret(brand.providers.google.clientSecret),
                        driveApiKey: maskSecret(brand.providers.google.driveApiKey),
                        photosApiKey: maskSecret(brand.providers.google.photosApiKey),
                        appId: brand.providers.google.appId ?? null,
                    } : null,
                    dropbox: brand.providers.dropbox ? {
                        key: maskSecret(brand.providers.dropbox.key),
                        secret: maskSecret(brand.providers.dropbox.secret),
                    } : null,
                    facebook: brand.providers.facebook ? {
                        key: maskSecret(brand.providers.facebook.key),
                        secret: maskSecret(brand.providers.facebook.secret),
                    } : null,
                    instagram: brand.providers.instagram ? {
                        key: maskSecret(brand.providers.instagram.key),
                        secret: maskSecret(brand.providers.instagram.secret),
                    } : null,
                    onedrive: brand.providers.onedrive ? {
                        key: maskSecret(brand.providers.onedrive.key),
                        secret: maskSecret(brand.providers.onedrive.secret),
                    } : null,
                    box: brand.providers.box ? {
                        key: maskSecret(brand.providers.box.key),
                        secret: maskSecret(brand.providers.box.secret),
                    } : null,
                    unsplash: brand.providers.unsplash ? {
                        key: maskSecret(brand.providers.unsplash.key),
                        secret: maskSecret(brand.providers.unsplash.secret),
                    } : null,
                    zoom: brand.providers.zoom ? {
                        key: maskSecret(brand.providers.zoom.key),
                        secret: maskSecret(brand.providers.zoom.secret),
                    } : null,
                },
                // Enabled plugins
                enabledPlugins: brand.enabledPlugins,
                // CORS
                corsOrigins: brand.corsOrigins.map(o => typeof o === 'string' ? o : o.toString()),
                uploadUrls: brand.uploadUrls,
            };
        });

        res.json({
            brands,
            detailedView: showDetails,
            timestamp: Date.now(),
        });
    });

    // Mount companion for each brand
    for (const instance of companionInstances) {
        const brand = instance.brand;

        // Session is scoped to brand routes only — see sessionMiddleware comment above.
        app.use(`/${brand.id}`, sessionMiddleware);

        // Attach the concrete brand for routes under /{brandId}
        // NOTE: Using createBrandMiddleware() here would fall back to defaultBrand because
        // req.params.brand is not populated when mounting on a literal path like '/acme'.
        app.use(`/${brand.id}`, (req, _res, next) => {
            (req as AppRequest).brand = brand;
            next();
        });

        // Fix unexpected /default segment in OAuth callbacks for non-default brands
        if (brand.id !== brandRegistry.defaultBrand?.id) {
            app.use(`/${brand.id}`, (req, _res, next) => {
                if (req.url.startsWith('/default/')) {
                    req.url = req.url.replace(/^\/default/, '');
                }
                next();
            });
        }

        // Optional user attachment
        app.use(`/${brand.id}`, attachUser);

        // Uppy upload page - shows plugins based on brand providers
        app.get(`/${brand.id}/uppy`, serveUppyPage);
        app.get(`/${brand.id}/uppyModal.js`, serveUppyModalJs);

        // Mount custom API (S3 signing, etc.)
        app.use(`/${brand.id}/api`, apiRouter);

        // Mount companion at brand path
        app.use(brand.server.path, instance.app);

        console.log(`[server] Mounted companion for "${brand.id}" at ${brand.server.path}`);
        console.log(`[server] Uppy page at /${brand.id}/uppy`);
    }

    // Error handler
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        console.error('[server] Unhandled error:', err);
        res.status(500).json({ error: 'Internal server error' });
    });

    return { app, brandRegistry, companionInstances };
};

export { attachCompanionSocket };
