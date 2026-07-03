import type { Brand } from '../brand/brand.types.js';
import type { Folder, FoldersResponse } from './folders.types.js';
import { logger } from '../../lib/logger.js';

/**
 * Fetches user folders from the brand's folders endpoint
 * 
 * @param token - Auth token for the request
 * @param brand - Brand configuration
 * @returns Array of folders or empty array on failure
 */
export const fetchFolders = async (
    token: string,
    brand: Brand
): Promise<Folder[]> => {
    const foldersUrl = brand.public.foldersUrl;

    if (!foldersUrl) {
        logger.warn({ brand: brand.id }, '[folders] No foldersUrl configured for brand');
        return [];
    }

    // Build full URL from backend URL + folders path
    const fullUrl = foldersUrl.startsWith('http')
        ? foldersUrl
        : `${brand.public.backendUrl}${foldersUrl}`;

    try {
        const response = await fetch(fullUrl, {
            method: 'GET',
            headers: {
                'Cookie': `${brand.auth.cookieName}=${token}`,
            },
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            logger.error({ brand: brand.id, status: response.status }, '[folders] Failed to fetch folders for brand');
            return [];
        }

        const json: FoldersResponse = await response.json();

        if (json.success && Array.isArray(json.data)) {
            return json.data;
        }

        return [];
    } catch (error) {
        logger.error({ err: error, brand: brand.id }, '[folders] Error fetching folders for brand');
        return [];
    }
};
