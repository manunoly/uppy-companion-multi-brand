import type { Brand } from '../brand/brand.types.js';
import { validateWhoamiUrl } from '../brand/identity.js';
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
 * @param forwardCookie - The `Cookie:` header resolveSession already decided to relay for this
 *   jar. Never rebuild one here: only the resolver knows whether `session_data` was distrusted.
 * @param brand - Resolved brand configuration.
 * @returns Array of folders or empty array on failure/misconfiguration.
 */
export const fetchFolders = async (
    forwardCookie: string | undefined,
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

    // The header was built and validated by resolveSession (buildCookieHeader is the single
    // auditable point where a brand cookie is forwarded); an absent one means the request has no
    // relayable session and there is nothing to ask on its behalf.
    if (!forwardCookie) {
        return [];
    }

    try {
        const response = await fetch(target.url, {
            method: 'GET',
            headers: {
                'Cookie': forwardCookie,
            },
            // N5 (mismo patrón que session-resolver whoami): NO seguir redirects.
            // El gate SSRF solo valida la URL inicial; un 3xx desde el host
            // permitido podría inducir una request server-side fuera del
            // allowlist. Con 'manual', cualquier 3xx cae en `!response.ok` y
            // degrada a [] (SA3), sin reenviar la cookie a un destino no validado.
            redirect: 'manual',
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
