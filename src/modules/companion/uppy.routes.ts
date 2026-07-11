import type { Response, NextFunction } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppRequest } from '../../core/types/express.js';
import type { Brand, EdoUploadPlugin } from '../brand/brand.types.js';
import { resolveValidatedWhoamiTarget } from '../brand/identity.js';
import { brandEmbedOrigins } from '../../core/csp.js';
import { fetchFolders } from '../folders/folders.service.js';
import { logger } from '../../lib/logger.js';
const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');

/**
 * Escapes a value so it can appear safely inside a single-quoted JS string
 * literal embedded in an HTML <script> tag. Beyond the obvious quote/backslash
 * escapes, this also neutralizes:
 *   - `\n` and `\r` — single-quoted JS string literals cannot span lines, so
 *     a raw newline in the input would produce a SyntaxError at parse time.
 *   - `<` and `>` — escaped to JSON-valid `<`/`>`. This blocks
 *     `</script>` closure, `<!--`/`-->` HTML-comment openers, and any
 *     case-insensitive `<SCRIPT>`/`<!DOCTYPE` form, all in one rule.
 *   - U+2028 / U+2029 — JS treats these as line terminators, so an unescaped
 *     occurrence inside a string literal raises SyntaxError or breaks parsing.
 */
export const toJsStringLiteral = (value: string | undefined | null): string => {
    const str = value ?? '';
    const escaped = str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return `'${escaped}'`;
};

/**
 * Serializes data to JSON suitable for inline embedding in an HTML <script>.
 * Uses JSON-valid Unicode escapes for `<`/`>` and U+2028/U+2029 so the output
 * remains parseable by `JSON.parse` AND safe to inline in a script tag — no
 * `</script>` closure, no `<!--`/`-->` HTML comment markers, no JS line
 * terminators inside string literals.
 */
export const safeJsonForHtmlScript = (data: unknown): string => {
    return JSON.stringify(data)
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
};

/**
 * Gets the list of enabled plugins based on brand configuration.
 * Prefers the typed `upload.plugins` list (D2/7.1 — replaces the legacy
 * CSV `enabledPlugins`), falls back to provider detection.
 *
 * Hallazgo BAJO-3: the fallback derivation must ONLY ever emit names from the
 * typed `EdoUploadPlugin` allowlist. `companion.factory.ts`'s
 * `PLUGIN_PROVIDER_KEY` only wires OAuth for Facebook/Dropbox/
 * GoogleDrivePicker/GooglePhotosPicker/Url — `CompanionProviders` still
 * declares instagram/onedrive/box/unsplash/zoom for structural completeness,
 * but no `EdoUploadPlugin` maps to them. Emitting one of those names here
 * would render a Dashboard tab in uppyModal.ts with no working OAuth backend
 * behind it (a client-breaking bug, not just noise).
 */
export const getEnabledPlugins = (brand: Brand): EdoUploadPlugin[] => {
    if (brand.upload.plugins.length > 0) {
        return [...brand.upload.plugins];
    }

    // Fallback: detect plugins from configured providers, restricted to the
    // EdoUploadPlugin allowlist.
    const plugins: EdoUploadPlugin[] = ['Url'];

    if (brand.providers.google) {
        plugins.push('GoogleDrivePicker');
        plugins.push('GooglePhotosPicker');
    }

    if (brand.providers.dropbox) {
        plugins.push('Dropbox');
    }

    if (brand.providers.facebook) {
        plugins.push('Facebook');
    }

    return plugins;
};

/**
 * Treats a request URL as a server-relative path. Anything that could be
 * interpreted as absolute (`http://...`, protocol-relative `//host`,
 * `javascript:`, etc.) collapses to `/`. Used as a defensive guard before
 * embedding the value in a `?redirect=...` query parameter — see the
 * trust-contract note on `redirectToLoginOrShowError`.
 */
export const safePath = (originalUrl: string): string =>
    originalUrl.startsWith('/') && !originalUrl.startsWith('//') ? originalUrl : '/';

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
 * Minimal in-frame page served when an EMBEDDED (`?embed=1`) request is
 * unauthenticated. A 302 to sign-in would either load the login page inside
 * the iframe or be blocked by `frame-ancestors`, so instead we hand the parent
 * an `auth-required` postMessage and let it drive re-auth (top-level redirect /
 * modal). The target origin is the parent's `document.referrer` origin,
 * validated against the brand's embed allow-list (`brandEmbedOrigins`) — never
 * `'*'`, never a foreign origin. The inline `<script>` carries the per-request
 * CSP nonce and mirrors origin-guard.ts (the page is not part of the bundled
 * asset, so it cannot import it).
 */
const generateAuthRequiredPage = (allowedOrigins: string[], nonce: string): string => {
    const originsJson = safeJsonForHtmlScript(allowedOrigins);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <title>Session Expired</title>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
    <p>Your session has expired. Please sign in again.</p>
    <script nonce="${nonce}">
        (function () {
            var allowed = ${originsJson};
            var target = null;
            var referrer = document.referrer;
            if (referrer) {
                try {
                    var origin = new URL(referrer).origin;
                    if (allowed.indexOf(origin) !== -1) target = origin;
                } catch (e) { target = null; }
            }
            if (target) window.parent.postMessage({ type: 'auth-required' }, target);
        })();
    </script>
</body>
</html>`;
};

/**
 * When `req.user` is not populated (missing/invalid brand session, or — in
 * the interim fail-closed shim, Task 2.7 → Fase 3 — always), redirect the
 * user to the brand's `auth.signInUrl` (with a `?redirect=` back to /uppy) if
 * configured; otherwise render a static 401 page with manual login instructions.
 *
 * Trust contract: the dashboard at `signInUrl` MUST validate the `?redirect=`
 * value against an allow-list (e.g. only redirect back to URLs whose host
 * matches the brand's trusted apex) to prevent open-redirect abuse. Companion
 * only constructs the URL — it does not validate the redirect target. The
 * defensive guard on `req.originalUrl` below is a server-side sanity check,
 * not a substitute for the dashboard's allow-list.
 */
const redirectToLoginOrShowError = (
    req: AppRequest,
    res: Response,
    brand: Brand,
): void => {
    if (brand.auth.signInUrl) {
        try {
            const companionPublicUrl = brand.companionUrl || `${req.protocol}://${req.get('host') ?? ''}`;
            // Defensive: treat req.originalUrl strictly as a server-relative path.
            // `new URL(absolute, base)` ignores the base when the first arg is
            // absolute or protocol-relative, so a malformed/forwarded request with
            // an absolute-form target could otherwise let an attacker craft the
            // ?redirect= value pointed at any host (open-redirect amplifier).
            const safeOriginalPath = safePath(req.originalUrl);
            const fullCurrentUrl = new URL(safeOriginalPath, companionPublicUrl).toString();

            const loginUrl = new URL(brand.auth.signInUrl);
            loginUrl.searchParams.set('redirect', fullCurrentUrl);
            res.redirect(302, loginUrl.toString());
            return;
        } catch (err) {
            logger.error({ err, brand: brand.slug }, '[uppy] Failed to build login redirect URL');
            // Fall through to the static error page below.
        }
    }

    res.status(401).send(generateErrorPage(
        'Session Expired',
        'Your session has expired or you are not logged in. Please log in via the dashboard and try again.',
    ));
};

/**
 * Serves the Uppy upload page for a brand.
 *
 * `req.user` is expected to already be populated by `attachUser` (mounted
 * upstream in server.ts) — this handler does NOT re-validate the session
 * itself (no double-auth). During the interim fail-closed shim (Task 2.7 →
 * Fase 3), `attachUser` is a no-op and never populates `req.user`, so every
 * request falls through to the login redirect / static error page below
 * until Fase 3 wires up the real session-resolver.
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

    if (!req.user) {
        // Embedded frame: never 302 in-frame — signal the parent via postMessage.
        if (req.query.embed === '1') {
            res.set('Cache-Control', 'no-store');
            res.setHeader('Content-Type', 'text/html');
            res.status(401).send(generateAuthRequiredPage(brandEmbedOrigins(brand), res.locals.cspNonce ?? ''));
            return;
        }
        redirectToLoginOrShowError(req, res, brand);
        return;
    }

    // Folders fetch happens only when we are about to render — saves a
    // round-trip when the request would have redirected. The raw session
    // cookie value (not req.user) is what gets forwarded to foldersUrl.
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[brand.auth.sessionCookieName] ?? '';
    const folders = await fetchFolders(cookieToken, brand);

    try {
        const htmlPath = path.join(__dirname, 'uppy.html');
        let html = await fs.readFile(htmlPath, 'utf8');

        const enabledPlugins = getEnabledPlugins(brand);

        // Host-handed theme (query-param, no cookie): stamp the class on <html>
        // server-side so first paint matches before the deferred module runs.
        // `theme` comes from a closed set ('light'|'dark'), so no escaping needed.
        const theme: 'light' | 'dark' = req.query.theme === 'dark' ? 'dark' : 'light';

        // Replace placeholders. The bearer-token placeholder is intentionally
        // absent — the page no longer carries the token in any form.
        html = html.replace(/THEME_CLASS_VALUE/g, theme);
        html = html.replace(/BRAND_SLUG_VALUE/g, toJsStringLiteral(brand.slug));
        html = html.replace(/BRAND_NAME_VALUE/g, toJsStringLiteral(brand.name));
        html = html.replace(/BRAND_LOGO_URL_VALUE/g, toJsStringLiteral(''));
        // Security review: re-validate whoamiUrl against its own
        // `whoamiAllowedHosts` allowlist right here at the HTML-injection
        // point, instead of trusting `brand.auth.whoamiUrl` as-is. Under the
        // CURRENT auth flow this is unreachable in practice — reaching this
        // branch already requires `req.user` to be set, which itself
        // requires `resolveSession` (session-resolver.ts) to have already
        // run this exact same check successfully — but it's cheap,
        // pure/no-I/O, and a hard guarantee against this specific value ever
        // reaching client HTML unvalidated if that coupling ever changes.
        const whoamiTarget = resolveValidatedWhoamiTarget(brand);
        if (!whoamiTarget.ok) {
            logger.warn(
                { brand: brand.slug, reason: whoamiTarget.reason },
                '[uppy] whoamiUrl failed allowlist re-validation at HTML-injection point; omitting it from the page',
            );
        }
        const safeWhoamiUrl = whoamiTarget.ok ? whoamiTarget.whoamiUrl.toString() : '';
        html = html.replace(/BRAND_USER_ENDPOINT_VALUE/g, toJsStringLiteral(safeWhoamiUrl));
        html = html.replace(/COMPANION_URL_VALUE/g, toJsStringLiteral(brand.companionUrl));
        // Fase 5.1 retires the per-brand `/{slug}/...` mount path: this
        // Companion instance now serves the uppy page, the custom
        // `/api/uppy/*` API, AND the OAuth callbacks from the SAME origin
        // (brand.companionUrl), so SERVER_URL and COMPANION_URL are the same
        // value. Deliberately NOT '' (relative) — uppyModal.ts's own default
        // fallback is `SERVER_URL_VALUE || 'http://localhost:3000'`, and an
        // empty string is falsy in JS, which would silently resurrect that
        // unrelated dev fallback instead of the intended same-origin base.
        html = html.replace(/SERVER_URL_VALUE/g, toJsStringLiteral(brand.companionUrl));
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
        // postMessage target allow-list (upload-complete / auth-required) —
        // same origins as the frame-ancestors CSP directive (core/csp.ts).
        html = html.replace(/ALLOWED_ANCESTORS_VALUE/g, safeJsonForHtmlScript(brandEmbedOrigins(brand)));

        // Fase 5.4: the inline <script type="module"> needs the SAME nonce
        // helmet's CSP put in the script-src header for this request
        // (res.locals.cspNonce, set by the nonce middleware in server.ts,
        // Fase 5.2) — 'self' alone does not cover an inline script, and a
        // mismatch here would silently make Uppy fail to initialize.
        html = html.replace(/CSP_NONCE_VALUE/g, res.locals.cspNonce ?? '');

        // Authenticated, per-user document — never cached (OWASP recommendation).
        res.set('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        logger.error({ err: error, brand: brand.slug }, '[uppy] Error serving page for brand');
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
            logger.error({ err }, '[uppy] uppyModal.js exists but failed to access');
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
        logger.error({ err: error }, '[uppy] Error serving uppyModal.js');
        res.status(500).send('Error loading script');
    }
};
