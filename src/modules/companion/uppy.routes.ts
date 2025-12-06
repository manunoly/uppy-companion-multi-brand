import type { Response, NextFunction } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppRequest } from '../../core/types/express.js';
import type { Brand } from '../brand/brand.types.js';
import { authenticate } from '../auth/auth.service.js';

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
        plugins.push('GoogleDrive');
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
    const cookieToken = (req.cookies as Record<string, string>)?.[brand.authCookieName] ?? null;
    const bearerToken = queryToken ?? cookieToken ?? '';

    // Verify authentication if brand has authUrl
    if (brand.authUrl && bearerToken) {
        const result = await authenticate(bearerToken, brand);
        if (!result.authenticated) {
            res.status(401).send('Unauthorized');
            return;
        }
        req.user = result.user;
    }

    try {
        const htmlPath = path.join(__dirname, 'uppy.html');
        let html = await fs.readFile(htmlPath, 'utf8');

        // Get enabled plugins for this brand
        const enabledPlugins = getEnabledPlugins(brand);

        // Build companion URL
        const companionUrl = `${brand.server.protocol}://${brand.server.host}${brand.server.path}`;

        // Replace placeholders
        html = html.replace(/BEARER_TOKEN_VALUE/g, toJsStringLiteral(bearerToken));
        html = html.replace(/BRAND_SLUG_VALUE/g, toJsStringLiteral(brand.id));
        html = html.replace(/BRAND_NAME_VALUE/g, toJsStringLiteral(brand.displayName));
        html = html.replace(/BRAND_LOGO_URL_VALUE/g, toJsStringLiteral(''));
        html = html.replace(/BRAND_USER_ENDPOINT_VALUE/g, toJsStringLiteral(brand.authUrl ?? ''));
        html = html.replace(/COMPANION_URL_VALUE/g, toJsStringLiteral(companionUrl));
        html = html.replace(/SERVER_URL_VALUE/g, toJsStringLiteral(`/${brand.id}/proxy`));
        html = html.replace(/PUBLIC_BACKEND_URL_VALUE/g, toJsStringLiteral(brand.publicBackendUrl));
        html = html.replace(/GOOGLE_API_KEY_VALUE/g, toJsStringLiteral(brand.providers.google?.key ?? ''));
        html = html.replace(/GOOGLE_DRIVE_CLIENT_ID_VALUE/g, toJsStringLiteral(brand.providers.google?.key ?? ''));

        // Replace plugins array
        html = html.replace(
            /plugins:\s*\[[\s\S]*?\]/,
            `plugins: ${JSON.stringify(enabledPlugins)}`
        );

        // Set cookie if token was provided
        if (bearerToken && queryToken) {
            res.cookie(brand.authCookieName, bearerToken, {
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
