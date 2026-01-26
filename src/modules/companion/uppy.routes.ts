import type { Response, NextFunction } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppRequest } from '../../core/types/express.js';
import type { Brand } from '../brand/brand.types.js';
import { authenticate } from '../auth/auth.service.js';
import { fetchFolders } from '../folders/folders.service.js';
const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');

/**
 * Escapes a string for use as a JavaScript string literal
 */
const toJsStringLiteral = (value: string | undefined | null): string => {
    const str = value ?? '';
    const escaped = str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'${escaped}'`;
};

/**
 * Gets the list of enabled plugins based on brand providers
 */
const getEnabledPlugins = (brand: Brand): string[] => {
    const plugins: string[] = [];

    // URL plugin is always available
    plugins.push('Url');

    // Add plugins based on configured providers
    if (brand.providers.google) {
        // this is the legacy plugin, avoid using it for Picker flows
        // plugins.push('GoogleDrive');
        plugins.push('GoogleDrivePicker');
        plugins.push('GooglePhotosPicker');
    }

    if (brand.providers.dropbox) {
        plugins.push('Dropbox');
    }

    if (brand.providers.facebook) {
        plugins.push('Facebook');
        plugins.push('Instagram');
    }

    if (brand.providers.onedrive) {
        plugins.push('OneDrive');
    }

    if (brand.providers.box) {
        plugins.push('Box');
    }

    if (brand.providers.unsplash) {
        plugins.push('Unsplash');
    }

    if (brand.providers.zoom) {
        plugins.push('Zoom');
    }

    return plugins;
};

/**
 * Generates an error page HTML
 */
const generateErrorPage = (title: string, message: string): string => {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <title>${title}</title>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #fff;
        }
        .error-container {
            text-align: center;
            padding: 2rem;
            max-width: 400px;
        }
        .error-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
        }
        h1 {
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
            color: #ff6b6b;
        }
        p {
            color: #a0aec0;
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div class="error-container">
        <div class="error-icon">🔒</div>
        <h1>${title}</h1>
        <p>${message}</p>
    </div>
</body>
</html>`;
};

/**
 * Serves the Uppy upload page for a brand
 */
export const serveUppyPage = async (
    req: AppRequest,
    res: Response,
    _next: NextFunction
): Promise<void> => {
    const brand = req.brand;

    if (!brand) {
        res.status(400).send('Brand not resolved');
        return;
    }

    // Get bearer token
    const queryToken = typeof req.query.bearerToken === 'string' ? req.query.bearerToken : null;
    const cookieToken = (req.cookies as Record<string, string>)?.[brand.auth.cookieName] ?? null;
    const bearerToken = queryToken ?? cookieToken ?? '';

    // Check if auth is required
    if (!brand.auth.url) {
        // Auth not configured - show error
        res.status(403).send(generateErrorPage(
            'Authentication Required',
            'This upload page requires authentication but the brand has no auth URL configured.'
        ));
        return;
    }

    if (!bearerToken) {
        // No token provided - show error
        res.status(401).send(generateErrorPage(
            'Session Expired',
            'Your session has expired or you are not logged in. Please log in and try again.'
        ));
        return;
    }

    // Run authentication and folder fetching in parallel
    const [authResult, folders] = await Promise.all([
        authenticate(bearerToken, brand),
        fetchFolders(bearerToken, brand),
    ]);

    // Check authentication result
    if (!authResult.authenticated) {
        res.status(401).send(generateErrorPage(
            'Unauthorized',
            'Your session is invalid or has expired. Please log in again.'
        ));
        return;
    }

    req.user = authResult.user;

    try {
        const htmlPath = path.join(__dirname, 'uppy.html');
        let html = await fs.readFile(htmlPath, 'utf8');

        // Get enabled plugins for this brand
        const enabledPlugins = getEnabledPlugins(brand);

        // Build companion URL (Prefer explicit override for Proxies)
        const companionUrl = brand.companionUrl
            ? brand.companionUrl
            : `${brand.server.protocol}://${brand.server.host}${brand.server.path}`;

        // Replace placeholders
        html = html.replace(/BEARER_TOKEN_VALUE/g, toJsStringLiteral(bearerToken));
        html = html.replace(/BRAND_SLUG_VALUE/g, toJsStringLiteral(brand.id));
        html = html.replace(/BRAND_NAME_VALUE/g, toJsStringLiteral(brand.displayName));
        html = html.replace(/BRAND_LOGO_URL_VALUE/g, toJsStringLiteral(''));
        html = html.replace(/BRAND_USER_ENDPOINT_VALUE/g, toJsStringLiteral(brand.auth.url ?? ''));
        html = html.replace(/COMPANION_URL_VALUE/g, toJsStringLiteral(companionUrl));
        html = html.replace(/SERVER_URL_VALUE/g, toJsStringLiteral(`/${brand.id}`));
        html = html.replace(/PUBLIC_BACKEND_URL_VALUE/g, toJsStringLiteral(brand.public.backendUrl));
        html = html.replace(/PUBLIC_UPLOAD_URL_VALUE/g, toJsStringLiteral(brand.public.uploadUrl));
        html = html.replace(/GOOGLE_API_KEY_DRIVE_VALUE/g, toJsStringLiteral(brand.providers.google?.driveApiKey ?? ''));
        html = html.replace(/GOOGLE_API_KEY_PHOTOS_VALUE/g, toJsStringLiteral(brand.providers.google?.photosApiKey ?? ''));
        html = html.replace(/GOOGLE_CLIENT_ID_VALUE/g, toJsStringLiteral(brand.providers.google?.clientId ?? ''));
        html = html.replace(/GOOGLE_APP_ID_VALUE/g, toJsStringLiteral(brand.providers.google?.appId ?? ''));

        // Inject folders data
        html = html.replace(/FOLDERS_DATA_VALUE/g, JSON.stringify(folders));

        // Replace plugins array
        html = html.replace(
            /plugins:\s*\[[\s\S]*?\]/,
            `plugins: ${JSON.stringify(enabledPlugins)}`
        );

        // Set cookie if token was provided
        if (bearerToken && queryToken) {
            res.cookie(brand.auth.cookieName, bearerToken, {
                httpOnly: false,
                secure: brand.server.protocol === 'https',
                maxAge: 12 * 60 * 60 * 1000, // 12 hours
            });
        }

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error(`[uppy] Error serving page for brand "${brand.id}":`, error);
        res.status(500).send('Error loading upload page');
    }
};

import { transform } from 'esbuild';

/**
 * Serves the uppyModal.js file (transpiled from TS)
 */
export const serveUppyModalJs = async (
    _req: AppRequest,
    res: Response,
    _next: NextFunction
): Promise<void> => {
    try {
        const tsPath = path.join(__dirname, 'uppyModal.ts');
        const ts = await fs.readFile(tsPath, 'utf8');

        const result = await transform(ts, {
            loader: 'ts',
            target: 'es2020',
            format: 'esm', // Use ESM for module support
        });

        res.setHeader('Content-Type', 'application/javascript');
        res.send(result.code);
    } catch (error) {
        console.error('[uppy] Error serving uppyModal.js:', error);
        res.status(500).send('Error loading script');
    }
};
