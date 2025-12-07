import express from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';

import { env } from './config/index.js';
import {
    createBrandRegistry,
    createBrandMiddleware,
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
    app.use(session({
        name: 'companion.sid',
        secret: env.secret,
        resave: false,
        saveUninitialized: true, // Needed to ensure session exists before OAuth redirect
        proxy: true, // Crucial for secure cookies behind reverse proxies like Railway
        cookie: {
            secure: env.protocol === 'https',
            sameSite: env.protocol === 'https' ? 'none' : 'lax',
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000 // 1 day
        }
    }));

    // Create brand registry
    const brandRegistry: BrandRegistry = createBrandRegistry({
        corsOrigins: env.corsOrigins,
        secret: env.secret,
        filePath: env.filePath,
        host: env.publicHost,
        protocol: env.protocol,
    });

    // Create companion instances for each brand
    const companionInstances: CompanionInstance[] = [];
    for (const brand of brandRegistry.brands.values()) {
        const instance = createCompanionForBrand(brand);
        companionInstances.push(instance);
    }

    // Health check (no auth required)
    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok', timestamp: Date.now() });
    });

    // List all brands (no auth required)
    app.get('/api/brands', (_req, res) => {
        const brands = getAllBrands(brandRegistry).map(brand => ({
            id: brand.id,
            displayName: brand.displayName,
            path: brand.server.path,
            providersEnabled: Object.keys(brand.providers).filter(
                k => brand.providers[k as keyof typeof brand.providers]
            ),
        }));
        res.json({ brands });
    });

    // Root endpoint
    app.get('/', (_req, res) => {
        res.send('Hello World');
    });

    // Mount companion for each brand
    for (const instance of companionInstances) {
        const brand = instance.brand;

        // Brand middleware for routes under /:brand
        app.use(`/${brand.id}`, createBrandMiddleware(brandRegistry));

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
