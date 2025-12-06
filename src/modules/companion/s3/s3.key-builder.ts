import type { AppRequest } from '../../../core/types/express.js';

/**
 * Validates user data from metadata
 */
const validateUser = (userJson: string | undefined): string | null => {
    if (!userJson) return null;

    try {
        const user = JSON.parse(userJson) as Record<string, unknown>;
        if (user && typeof user.id !== 'undefined') {
            return String(user.id);
        }
        return null;
    } catch {
        console.warn('[s3] Failed to parse user from metadata');
        return null;
    }
};

/**
 * Sanitizes a filename to be safe for S3
 */
const sanitizeFilename = (name: string | undefined | null): string => {
    if (!name) return 'untitled';
    return name.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 255) || 'untitled';
};

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
    const sanitizedFilename = sanitizeFilename(filename);

    if (!sanitizedFilename) {
        throw new Error('Invalid filename');
    }

    // Get brand from request or metadata
    const brandSource = req.brand?.id ??
        (metadata?.brand as string | undefined) ??
        'default';
    const sanitizedBrand = brandSource.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Get user ID from request or metadata
    let userId: string | null = null;

    // Try from req.user first
    if (req.user?.id) {
        userId = req.user.id;
    }

    // Then try from metadata
    if (!userId && metadata?.user) {
        userId = validateUser(metadata.user as string);
    }

    if (!userId) {
        // Fallback temporal solicitado por el usuario
        console.warn('[s3] No user found, using fallback user id 3');
        userId = '3';
        // throw new Error('Invalid user or token on metadata');
    }

    // Update metadata with sanitized values
    if (metadata) {
        metadata.brand = sanitizedBrand;
        metadata.name = sanitizedFilename;
    }

    const now = new Date();
    const timestamp = `${now.getHours()}${now.getMinutes()}${now.getSeconds()}${now.getMilliseconds()}`;

    return `${sanitizedBrand}/original/${userId}/${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}/${timestamp}/${sanitizedFilename}`;
};
