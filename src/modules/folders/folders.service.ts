import type { Brand } from '../brand/brand.types.js';
import type { Folder, FoldersResponse } from './folders.types.js';
import { logger } from '../../lib/logger.js';

/**
 * Fetches user folders from the brand's folders endpoint (SA3: conserved,
 * degrades to `[]` + a warn log on any failure — the designer doesn't
 * currently consume this, but it's kept in case Dropbox/GoogleDrivePicker
 * get enabled for a brand).
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

    try {
        const response = await fetch(foldersUrl, {
            method: 'GET',
            headers: {
                'Cookie': `${brand.auth.sessionCookieName}=${token}`,
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
