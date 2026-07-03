import type { AppRequest } from '../../../core/types/express.js';
import { logger } from '../../../lib/logger.js';

/**
 * Sanitizes a filename to be safe for S3
 */
const sanitizeFilename = (name: string | undefined | null): string => {
    if (!name) return 'untitled';
    // Ensure we don't end up with an empty string after sanitization
    return name.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 255) || 'untitled';
};

const sanitizeBrand = (brandSource: string): string =>
    brandSource.toLowerCase().replace(/[^a-z0-9-]/g, '-');

/**
 * Returns the S3 key prefix that scopes uploads to a single (brand, user) pair.
 * Used both to build new keys and to validate that a client-supplied key
 * belongs to the authenticated user (defense against BOLA).
 */
export const buildUserKeyPrefix = (brandId: string, userId: string): string =>
    `${sanitizeBrand(brandId)}/original/${userId}/`;

export interface BuildS3KeyParams {
    req: AppRequest;
    filename?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Builds an S3 key for uploaded files
 * 
 * Format: {brand}/original/{userId}/{year}/{month}/{day}/{timestamp}/{filename}
 */
export const buildS3Key = ({ req, filename, metadata }: BuildS3KeyParams): string => {
    // Try to find a valid filename from various sources
    const candidateName = filename || (metadata?.name as string) || (metadata?.filename as string);
    const sanitizedFilename = sanitizeFilename(candidateName);

    if (!sanitizedFilename || sanitizedFilename === 'untitled') {
        // Only log warning if we really couldn't find a name, but proceed with 'untitled' to avoid crash
        if (!candidateName) logger.warn('[s3] Filename missing in buildS3Key, using untitled');
    }

    const brandSource = req.brand?.id ??
        (metadata?.brand as string | undefined) ??
        'default';
    const sanitizedBrand = sanitizeBrand(brandSource);

    // Identity must come from server-validated req.user only. Client-supplied
    // metadata fields like metadata.user are NOT trusted (would be BOLA).
    // requireAuth on /api/uppy/* guarantees this invariant.
    const userId = req.user?.id;
    if (!userId) {
        throw new Error('s3.key-builder: userId required (req.user not populated)');
    }

    if (metadata) {
        metadata.brand = sanitizedBrand;
        metadata.name = sanitizedFilename;
    }

    const now = new Date();
    const timestamp = `${now.getHours()}${now.getMinutes()}${now.getSeconds()}${now.getMilliseconds()}`;
    const prefix = buildUserKeyPrefix(sanitizedBrand, userId);

    return `${prefix}${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}/${timestamp}/${sanitizedFilename}`;
};
