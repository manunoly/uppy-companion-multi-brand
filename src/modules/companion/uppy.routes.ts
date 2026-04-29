import type { Response, NextFunction } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppRequest } from '../../core/types/express.js';
import type { Brand } from '../brand/brand.types.js';
import { authenticate } from '../auth/auth.service.js';
import { fetchFolders } from '../folders/folders.service.js';
const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');

/**
 * Escapes a value so it can appear safely inside a single-quoted JS string
 * literal embedded in an HTML <script> tag. Beyond the obvious quote/backslash
 * escapes, this also neutralizes:
 *   - `</` (and `<!--`/`-->`) — would otherwise let a value close the script
 *     tag or open an HTML comment that survives the `</script>` boundary.
 *   - U+2028 / U+2029 — JS treats these as line terminators, so an unescaped
 *     occurrence inside a string literal raises SyntaxError or breaks parsing.
 */
const toJsStringLiteral = (value: string | undefined | null): string => {
    const str = value ?? '';
    const escaped = str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/<\//g, '<\\/')
        .replace(/<!--/g, '<\\!--')
        .replace(/-->/g, '--\\>')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return `'${escaped}'`;
};

/**
 * Serializes data to JSON suitable for inline embedding in an HTML <script>.
 * Standard JSON.stringify can produce `</` (closing the script tag) or
 * U+2028/U+2029 (which JS parses as line terminators). Both are escaped here.
 * Output is still valid JSON parseable by the browser's JS engine.
 */
const safeJsonForHtmlScript = (data: unknown): string => {
    return JSON.stringify(data)
        .replace(/<\//g, '<\\/')
        .replace(/<!--/g, '<\\!--')
        .replace(/-->/g, '--\\>')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
};

/**
 * Gets the list of enabled plugins based on brand configuration
 * Prefers explicit enabledPlugins config, falls back to provider detection
 */
const getEnabledPlugins = (brand: Brand): string[] => {
    // If brand has explicit enabledPlugins config, use it
    if (brand.enabledPlugins && brand.enabledPlugins.length > 0) {
        return brand.enabledPlugins;
    }

    // Fallback: detect plugins from configured providers
    const plugins: string[] = [];

    // URL plugin is always available
    plugins.push('Url');

    if (brand.providers.google) {
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
 * When the brand session cookie is missing or invalid, redirect the user to
 * the brand's login page (with a `?redirect=` back to /uppy) if configured;
 * otherwise render a static 401 page with manual login instructions.
 *
 * Trust contract: the dashboard at `loginUrl` MUST validate the `?redirect=`
 * value against an allow-list (e.g. only redirect back to URLs whose host
 * matches `*.<rootDomain>`) to prevent open-redirect abuse. Companion only
 * constructs the URL — it does not validate the redirect target. The
 * defensive guard on `req.originalUrl` below is a server-side sanity check,
 * not a substitute for the dashboard's allow-list.
 */
const redirectToLoginOrShowError = (
    req: AppRequest,
    res: Response,
    brand: Brand,
): void => {
    if (brand.public.loginUrl) {
        const companionPublicUrl = brand.companionUrl
            ?? `${brand.server.protocol}://${brand.server.host}`;
        // Defensive: treat req.originalUrl strictly as a server-relative path.
        // `new URL(absolute, base)` ignores the base when the first arg is
        // absolute or protocol-relative, so a malformed/forwarded request with
        // an absolute-form target could otherwise let an attacker craft the
        // ?redirect= value pointed at any host (open-redirect amplifier).
        const safePath = req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//')
            ? req.originalUrl
            : '/';
        const fullCurrentUrl = new URL(safePath, companionPublicUrl).toString();

        const loginUrl = new URL(brand.public.loginUrl);
        loginUrl.searchParams.set('redirect', fullCurrentUrl);
        res.redirect(302, loginUrl.toString());
        return;
    }

    res.status(401).send(generateErrorPage(
        'Session Expired',
        'Your session has expired or you are not logged in. Please log in via the dashboard and try again.',
    ));
};

/**
 * Serves the Uppy upload page for a brand
 */
export const serveUppyPage = async (
    req: AppRequest,
    res: Response,
    _next: NextFunction,
): Promise<void> => {
    const brand = req.brand;

    if (!brand) {
        res.status(400).send('Brand not resolved');
        return;
    }

    // Brands without auth.url cannot receive authenticated uploads.
    if (!brand.auth.url) {
        res.status(403).send(generateErrorPage(
            'Authentication Required',
            'This upload page requires authentication but the brand has no auth URL configured.',
        ));
        return;
    }

    // Cookie-only auth: the browser sends the brand session cookie
    // (Domain=.<rootDomain>) automatically when the user is logged in.
    // No more query-string token, no more server-side token injection in the page.
    const cookieToken = (req.cookies as Record<string, string>)?.[brand.auth.cookieName] ?? null;
    if (!cookieToken) {
        return redirectToLoginOrShowError(req, res, brand);
    }

    const authResult = await authenticate(cookieToken, brand);
    if (!authResult.authenticated || !authResult.user) {
        return redirectToLoginOrShowError(req, res, brand);
    }

    req.user = authResult.user;

    // Folders fetch happens only when we are about to render — saves a
    // round-trip when the request would have redirected.
    const folders = await fetchFolders(cookieToken, brand);

    try {
        const htmlPath = path.join(__dirname, 'uppy.html');
        let html = await fs.readFile(htmlPath, 'utf8');

        const enabledPlugins = getEnabledPlugins(brand);

        const companionUrl = brand.companionUrl
            ? brand.companionUrl
            : `${brand.server.protocol}://${brand.server.host}${brand.server.path}`;

        // Replace placeholders. BEARER_TOKEN_VALUE is intentionally absent:
        // the page no longer carries the token in any form.
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
        // Use safeJsonForHtmlScript (NOT raw JSON.stringify) for any inline
        // JSON injection. Folder names come from the brand backend; without
        // escaping `</`, `<!--`, `-->`, U+2028 and U+2029 a malicious or
        // corrupted value would break out of the surrounding <script> tag.
        html = html.replace(/FOLDERS_DATA_VALUE/g, safeJsonForHtmlScript(folders));
        html = html.replace(/ENABLED_PLUGINS_VALUE/g, safeJsonForHtmlScript(enabledPlugins));

        // Authenticated, per-user document — never cached (OWASP recommendation).
        res.set('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error(`[uppy] Error serving page for brand "${brand.id}":`, error);
        res.status(500).send('Error loading upload page');
    }
};

// Memoized in-process cache for the dev-mode transpile fallback. Keyed by source
// content so an in-place edit to uppyModal.ts naturally invalidates the cache,
// and tsx-watch restarts wipe the cache anyway.
let devTranspiledCache: { source: string; output: string } | null = null;

const transpileForDev = async (tsSource: string): Promise<string> => {
    if (devTranspiledCache?.source === tsSource) return devTranspiledCache.output;
    // Dynamic import: esbuild is a devDependency. Production never hits this branch
    // because uppyModal.js is precompiled by scripts/build-assets.mjs.
    const { transform } = await import('esbuild');
    const result = await transform(tsSource, {
        loader: 'ts',
        target: 'es2020',
        format: 'esm',
    });
    devTranspiledCache = { source: tsSource, output: result.code };
    return result.code;
};

/**
 * Serves the uppyModal.js file. Prefers the precompiled artifact (prod);
 * falls back to on-demand transpilation when only the .ts source is present (dev).
 */
export const serveUppyModalJs = async (
    _req: AppRequest,
    res: Response,
    _next: NextFunction
): Promise<void> => {
    const jsPath = path.join(__dirname, 'uppyModal.js');

    try {
        await fs.access(jsPath);
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/javascript');
        res.sendFile(jsPath);
        return;
    } catch (err) {
        // Only fall through to the dev transpile when the precompiled artifact is
        // genuinely missing. Other errors (permissions, IO) should surface as 500
        // — in production esbuild is a devDependency and the dynamic import would
        // crash, masking the real failure.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
            console.error('[uppy] uppyModal.js exists but failed to access:', err);
            res.status(500).send('Error loading script');
            return;
        }
    }

    try {
        const tsPath = path.join(__dirname, 'uppyModal.ts');
        const tsSource = await fs.readFile(tsPath, 'utf8');
        const code = await transpileForDev(tsSource);
        res.setHeader('Content-Type', 'application/javascript');
        res.send(code);
    } catch (error) {
        console.error('[uppy] Error serving uppyModal.js:', error);
        res.status(500).send('Error loading script');
    }
};
