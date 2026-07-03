import express from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { timingSafeEqual } from 'node:crypto';
import { HeadBucketCommand } from '@aws-sdk/client-s3';

import { env, type EnvConfig } from './config/index.js';
import type { AppRequest } from './core/types/express.js';
import {
    createBrandRegistry,
    getAllBrands,
    type Brand,
    type ResolvedBrandRegistry
} from './modules/brand/index.js';
import { attachUser, requireAuth } from './modules/auth/index.js';
import { corsForBrand } from './core/cors.js';
import {
    createCompanionForBrand,
    attachCompanionSocket,
    serveUppyPage,
    serveUppyModalJs,
    apiRouter,
    type CompanionInstance
} from './modules/companion/index.js';
import { getRedis } from './lib/redis.js';
import { logger, httpLogger, runWithContext } from './lib/logger.js';

export interface AssembleAppParams {
    env: EnvConfig;
    brandRegistry: ResolvedBrandRegistry;
    companionInstances: CompanionInstance[];
}

export interface AssembledApp {
    app: express.Express;
    /** Flips liveness/readiness to 503 (SIGTERM drain) — see src/index.ts. */
    setShuttingDown: (value: boolean) => void;
}

interface ServerResult {
    app: express.Express;
    brandRegistry: ResolvedBrandRegistry;
    companionInstances: CompanionInstance[];
    setShuttingDown: (value: boolean) => void;
}

// Constant-time comparison to avoid timing attacks on HEALTH_CHECK_KEY.
const safeEqual = (a: string, b: string): boolean => {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

/** Readiness: Redis must answer PING within 1s. */
const checkRedis = async (): Promise<boolean> => {
    try {
        const reply = await withTimeout(getRedis().ping(), 1000);
        return reply === 'PONG';
    } catch (error) {
        logger.warn({ err: error }, '[readyz] Redis check failed');
        return false;
    }
};

/**
 * Readiness: S3 must be reachable. Only one servable brand needs checking —
 * all brands in a given deployment share the same AWS account/network path,
 * so this is a proxy for "can we reach S3 at all", not a per-brand check.
 * If no brand has S3 configured (e.g. a minimal dev setup), there is nothing
 * to check and we don't fail readiness for it.
 */
const checkS3 = async (brandRegistry: ResolvedBrandRegistry): Promise<boolean> => {
    const brand: Brand | undefined = getAllBrands(brandRegistry).find(b => b.s3.client && b.s3.bucket);
    if (!brand?.s3.client) return true;

    // Also pass an AbortSignal so the underlying HTTP request is actually
    // cancelled (not just abandoned) when it's too slow; `withTimeout` is
    // what guarantees this function itself settles in ~1.5s regardless of
    // whether the client honors the signal (e.g. under test mocks).
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 1500);
    try {
        await withTimeout(
            brand.s3.client.send(new HeadBucketCommand({ Bucket: brand.s3.bucket }), {
                abortSignal: controller.signal,
            }),
            1500,
        );
        return true;
    } catch (error) {
        logger.warn({ err: error, brand: brand.slug }, '[readyz] S3 check failed');
        return false;
    } finally {
        clearTimeout(abortTimer);
    }
};

export const assembleApp = ({
    env: envParam,
    brandRegistry,
    companionInstances,
}: AssembleAppParams): AssembledApp => {
    const app = express();

    // Flipped by index.ts on SIGTERM so liveness/readiness start failing
    // immediately, ahead of the orchestrator draining traffic away from us.
    let shuttingDown = false;
    const setShuttingDown = (value: boolean): void => {
        shuttingDown = value;
    };

    // Trust proxy for proper IP detection (Standard for Railway/AWS/Heroku)
    app.set('trust proxy', 1);

    // Request logging + context, first so every downstream middleware/handler
    // (including error handling) can log with requestId attached. pino-http
    // assigns `req.id` (from `x-request-id` or a fresh UUID, see lib/logger.ts)
    // before we open the AsyncLocalStorage frame for the rest of the request's
    // async chain.
    app.use((req, res, next) => {
        httpLogger(req, res, () => {
            runWithContext({ requestId: String(req.id) }, next);
        });
    });

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(cookieParser());

    // Session middleware is mounted per-brand below (not globally) so health
    // checks, /api/brands, and 404s don't create empty sessions or set cookies.
    // Each brand gets its own middleware instance with a brand-scoped cookie name
    // and path, so cookies cannot leak across brands and OAuth state from one
    // brand cannot overwrite another's. `saveUninitialized: true` is intentional:
    // Companion's OAuth flow requires a persisted session before the redirect.
    // TODO(Fase 5.2, D7): move to a single static session name (`companion.sid`)
    // backed by connect-redis — per-brand path mounting is retired once brand
    // resolution moves to Host-based (Fase 5.1), at which point each brand
    // already lives on its own host and the browser isolates the cookie for us.
    const buildSessionMiddleware = (brandSlug: string) => session({
        name: `companion.sid.${brandSlug}`,
        secret: envParam.secret,
        resave: false,
        saveUninitialized: true,
        proxy: true, // Crucial for secure cookies behind reverse proxies like Railway
        cookie: {
            path: `/${brandSlug}`,
            secure: envParam.protocol === 'https',
            sameSite: envParam.protocol === 'https' ? 'none' : 'lax',
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000, // 1 day
        },
    });

    // Liveness: is the process itself still able to serve traffic at all?
    // Stays 200 until a SIGTERM drain starts (see index.ts), independent of
    // downstream dependencies (Redis/S3) — those are readyz's job.
    app.get('/api/healthz', (_req, res) => {
        if (shuttingDown) {
            res.status(503).json({ status: 'shutting-down', timestamp: Date.now() });
            return;
        }
        res.json({ status: 'ok', timestamp: Date.now() });
    });

    // Readiness: can this instance actually handle a request right now?
    // Checked by the orchestrator before routing traffic here / to decide
    // whether to keep it in the load-balancing pool.
    app.get('/api/readyz', async (_req, res) => {
        if (shuttingDown) {
            res.status(503).json({ status: 'shutting-down', redis: false, s3: false, timestamp: Date.now() });
            return;
        }

        const [redisOk, s3Ok] = await Promise.all([checkRedis(), checkS3(brandRegistry)]);
        if (redisOk && s3Ok) {
            res.json({ status: 'ok', redis: true, s3: true, timestamp: Date.now() });
        } else {
            res.status(503).json({ status: 'unavailable', redis: redisOk, s3: s3Ok, timestamp: Date.now() });
        }
    });

    app.get('/api/brands', (req, res) => {
        const queryKey = typeof req.query.key === 'string' ? req.query.key : null;
        const healthCheckKey = envParam.healthCheckKey;
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

        const maskedProvider = (provider: { key: string; secret: string } | undefined) =>
            provider ? { key: maskSecret(provider.key), secret: maskSecret(provider.secret) } : null;

        const brands = getAllBrands(brandRegistry).map(brand => {
            // Basic info (always shown)
            const basicInfo = {
                id: brand.slug,
                displayName: brand.name,
            };

            // Return only basic info if key doesn't match
            if (!showDetails) {
                return basicInfo;
            }

            // Detailed info (only when key matches)
            return {
                ...basicInfo,
                urls: {
                    companion: brand.companionUrl,
                    whoami: brand.auth.whoamiUrl,
                    signIn: brand.auth.signInUrl,
                    signOut: brand.auth.signOutUrl ?? null,
                    foldersPublic: brand.public?.foldersUrl ?? null,
                },
                auth: {
                    kind: brand.auth.kind,
                    sessionCookieName: brand.auth.sessionCookieName,
                },
                s3: {
                    bucket: brand.s3.bucket,
                    region: brand.s3.region,
                    accessKey: maskSecret(brand.s3.accessKey),
                    secretKey: maskSecret(brand.s3.secretKey),
                    useAccelerateEndpoint: brand.s3.useAccelerateEndpoint ?? false,
                    clientConfigured: !!brand.s3.client,
                },
                providers: {
                    google: brand.providers.google ? {
                        clientId: brand.providers.google.clientId,
                        clientSecret: maskSecret(brand.providers.google.clientSecret),
                        driveApiKey: maskSecret(brand.providers.google.driveApiKey),
                        photosApiKey: maskSecret(brand.providers.google.photosApiKey),
                        appId: brand.providers.google.appId ?? null,
                    } : null,
                    dropbox: maskedProvider(brand.providers.dropbox),
                    facebook: maskedProvider(brand.providers.facebook),
                    instagram: maskedProvider(brand.providers.instagram),
                    onedrive: maskedProvider(brand.providers.onedrive),
                    box: maskedProvider(brand.providers.box),
                    unsplash: maskedProvider(brand.providers.unsplash),
                    zoom: maskedProvider(brand.providers.zoom),
                },
                upload: brand.upload,
                limits: brand.limits,
                domains: brand.domains,
                companionHosts: brand.companionHosts,
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
        const mountPath = `/${brand.slug}`;

        // Session is scoped to brand routes only — see buildSessionMiddleware comment above.
        app.use(mountPath, buildSessionMiddleware(brand.slug));

        // Attach the concrete brand for routes under /{brandSlug}
        // NOTE: Using createBrandMiddleware() here would fall back to no brand because
        // req.params.brand is not populated when mounting on a literal path like '/acme'.
        app.use(mountPath, (req, _res, next) => {
            (req as AppRequest).brand = brand;
            next();
        });

        // Optional user attachment
        app.use(mountPath, attachUser);

        // Uppy upload page - shows plugins based on brand providers
        app.get(`${mountPath}/uppy`, serveUppyPage);
        app.get(`${mountPath}/uppyModal.js`, serveUppyModalJs);

        // Mount custom API (S3 signing, etc.) behind per-brand CORS.
        // The middleware accepts any *.<apex> origin (HTTPS-only in prod) so
        // dashboards on sibling subdomains can call /api/uppy/* with cookies.
        app.use(`${mountPath}/api`, corsForBrand(brand, envParam.protocol), apiRouter);

        // Companion's own S3 multipart endpoints (/:brand/s3/...) invoke the
        // s3.getKey callback which calls buildS3Key — that callback throws if
        // req.user is not populated. Without requireAuth here, an unauthenticated
        // request would surface as 500 instead of a clean 401.
        app.use(`${mountPath}/s3`, requireAuth);

        // Mount companion at brand path
        app.use(mountPath, instance.app);

        logger.info({ brand: brand.slug, path: mountPath }, '[server] Mounted companion for brand');
        logger.info({ brand: brand.slug }, `[server] Uppy page at ${mountPath}/uppy`);
    }

    // Error handler
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        logger.error({ err }, '[server] Unhandled error');
        res.status(500).json({ error: 'Internal server error' });
    });

    return { app, setShuttingDown };
};

/**
 * Creates and configures the Express application
 */
export const createServer = (): ServerResult => {
    const brandRegistry: ResolvedBrandRegistry = createBrandRegistry({ secret: env.secret });

    const companionInstances: CompanionInstance[] = getAllBrands(brandRegistry).map(
        (brand) => createCompanionForBrand(brand, env),
    );

    const { app, setShuttingDown } = assembleApp({ env, brandRegistry, companionInstances });

    return { app, brandRegistry, companionInstances, setShuttingDown };
};

export { attachCompanionSocket };
