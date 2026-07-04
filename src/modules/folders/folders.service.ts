import type { Brand } from '../brand/brand.types.js';
import { buildCookieHeader, validateWhoamiUrl } from '../brand/identity.js';
import type { Folder, FoldersResponse } from './folders.types.js';
import { logger } from '../../lib/logger.js';

/**
 * Fetches user folders from the brand's folders endpoint (SA3: conserved —
 * the designer doesn't currently consume this, but it's kept in case
 * Dropbox/GoogleDrivePicker get enabled for a brand). Every path degrades to
 * `[]`; the config/precondition paths return silently — no configured
 * `foldersUrl` is expected, a non-empty token rejected by `buildCookieHeader`
 * is logged at debug — while a fetch that throws or returns non-ok logs a warn.
 *
 * `brand.public.foldersUrl` (D2) is expected to be a full absolute URL —
 * unlike the legacy contract, there is no `public.backendUrl` to resolve a
 * relative path against anymore.
 *
 * @param token - Raw session cookie value forwarded as `Cookie:` to foldersUrl.
 * @param brand - Resolved brand configuration.
 * @returns Array of folders or empty array on failure/misconfiguration.
 */
export const fetchFolders = async (
    token: string,
    brand: Brand
): Promise<Folder[]> => {
    const foldersUrl = brand.public?.foldersUrl;

    if (!foldersUrl) {
        return [];
    }

    // N5: validar foldersUrl por el mismo gate SSRF que whoami (https, sin
    // credenciales/puerto no-default, host bajo el apex de confianza de la
    // marca) ANTES de reenviar la cookie de sesión — foldersUrl es code-only
    // hoy, pero esto impide reintroducir un fetch sin allowlist.
    const target = validateWhoamiUrl(foldersUrl, brand.auth.whoamiAllowedHosts);
    if (!target.ok) {
        logger.warn({ brand: brand.slug, reason: target.reason }, '[folders] foldersUrl rejected by SSRF gate');
        return [];
    }

    // Hallazgo BAJO-1: build the outgoing Cookie header through
    // buildCookieHeader (identity.ts) — the single auditable point where a
    // brand cookie is forwarded — instead of raw template-string
    // interpolation. A delimiter/control-character-bearing token (`;`,
    // CR/LF, ...) returns null here rather than silently producing a
    // malformed/injectable header.
    const cookie = buildCookieHeader(brand.auth.sessionCookieName, token);
    if (!cookie) {
        // A present-but-rejected token (delimiter/control char) is anomalous — a
        // well-formed session cookie never contains those — so surface it at
        // debug for diagnosability, without logging the ordinary "no token" case.
        if (token) {
            logger.debug({ brand: brand.slug }, '[folders] Session cookie token rejected by buildCookieHeader');
        }
        return [];
    }

    try {
        const response = await fetch(target.url, {
            method: 'GET',
            headers: {
                'Cookie': cookie,
            },
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            logger.warn({ brand: brand.slug, status: response.status }, '[folders] Failed to fetch folders for brand');
            return [];
        }

        const json: FoldersResponse = await response.json();

        if (json.success && Array.isArray(json.data)) {
            return json.data;
        }

        return [];
    } catch (error) {
        logger.warn({ err: error, brand: brand.slug }, '[folders] Error fetching folders for brand');
        return [];
    }
};
