import type { AppRequest } from '../../../core/types/express.js';
import type { Brand, BrandUser } from '../../brand/brand.types.js';
import { logger } from '../../../lib/logger.js';

/**
 * Sanitizes a filename to be safe for S3
 */
const sanitizeFilename = (name: string | undefined | null): string => {
    if (!name) return 'untitled';
    // Ensure we don't end up with an empty string after sanitization
    return name.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 255) || 'untitled';
};

/**
 * Returns the S3 key prefix that scopes uploads to a single user. Used both
 * to build new keys and to validate that a client-supplied key belongs to the
 * authenticated user (defense against BOLA).
 *
 * SA1/D6: identity is ALWAYS the canonical `user.id` — never `edoId` (which is
 * only a designer-side *listing* extra for edo, populated by `enrichEdoUser`;
 * edo's real S3 objects are indexed by the canonical id — see spec SA1).
 * Per-brand isolation is by S3 BUCKET (`brand.s3.bucket`), not by a
 * `{brand}/` key prefix — `brand.assets.s3Prefix` is empty for edo and only
 * prepended for brands that opt into a code-only prefix.
 */
export const buildUserKeyPrefix = (brand: Brand, user: BrandUser): string => {
    const uid = user.id;
    if (!uid) {
        throw new Error('s3.key-builder: user.id required (canonical id missing)');
    }
    // Normalize the (code-only) s3Prefix to be either '' or '/'-terminated so a
    // future brand config that sets e.g. 'brands/abe' (no trailing slash) can't
    // silently produce a malformed 'brands/abeoriginal/...' key. This is the
    // SINGLE source of truth for both key building and the BOLA ownership check
    // (sendIfKeyNotOwned), so normalizing here keeps them consistent by
    // construction. edo ('') and abe/picaboo ('brands/.../') are unaffected.
    const rawPrefix = brand.assets.s3Prefix;
    const prefix = !rawPrefix || rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
    return `${prefix}original/${uid}/`;
};

export interface BuildS3KeyParams {
    req: AppRequest;
    filename?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Builds an S3 key for uploaded files.
 *
 * A SINGLE function, independent of brand (SA1/D6) — it must never branch on
 * `brand.slug`/`brand.auth.kind`. Every brand is keyed the same simple,
 * homogeneous scheme, homogenized upstream by `normalizeBrandUser`:
 *
 *   {s3Prefix}original/{id}/{year}/{month}/{day}/{timestamp}/{filename}
 *
 * No `UPID_{orderId}` segment (decision SA1: simple path, not the legacy
 * edonext pipeline convention).
 */
export const buildS3Key = ({ req, filename, metadata }: BuildS3KeyParams): string => {
    // Try to find a valid filename from various sources
    const candidateName = filename || (metadata?.name as string) || (metadata?.filename as string);
    const sanitizedFilename = sanitizeFilename(candidateName);

    if (!candidateName) {
        logger.warn('[s3] Filename missing in buildS3Key, using untitled');
    }

    const brand = req.brand;
    if (!brand) {
        throw new Error('s3.key-builder: brand required (req.brand not populated)');
    }

    // Identity must come from server-validated req.user only, and must be the
    // canonical `id` — NEVER `edoId` (SA1/D6). Client-supplied metadata fields
    // are NOT trusted (would be BOLA). requireAuth on /api/uppy/* guarantees
    // this invariant.
    const user = req.user;
    if (!user?.id) {
        throw new Error('s3.key-builder: userId required (req.user not populated)');
    }

    // Only mutate a real object: a client may send `metadata` as a stringified
    // "[object Object]" (urlencoded), and assigning a property to a string
    // primitive throws a TypeError in strict mode.
    if (metadata && typeof metadata === 'object') {
        metadata.name = sanitizedFilename;
    }

    const now = new Date();
    const timestamp = `${now.getHours()}${now.getMinutes()}${now.getSeconds()}${now.getMilliseconds()}`;
    const prefix = buildUserKeyPrefix(brand, user);

    return `${prefix}${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}/${timestamp}/${sanitizedFilename}`;
};
