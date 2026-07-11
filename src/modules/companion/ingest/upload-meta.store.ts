import { getRedis } from '../../../lib/redis.js';
import { logger } from '../../../lib/logger.js';

/**
 * Per-upload metadata stashed at multipart-create time and read back at
 * complete time, keyed by brand + S3 uploadId. The multipart create/complete
 * calls are separate HTTP requests (and may land on different replicas), so
 * the values the complete handler needs — folder, declared size, thumbnail
 * flag — cannot live in per-request memory. Redis is the shared, TTL-bounded
 * carrier. `userId` is the SERVER-validated `req.user.id` at create time
 * (never client-supplied) so a future async consumer can attribute the object
 * without a request context.
 */
export interface UploadMeta {
    readonly filename: string;
    readonly mimetype: string;
    /** Client-declared post-compression size at create; `null` when undeclared. */
    readonly declaredSize: number | null;
    readonly folderId: number | null;
    readonly userId: string;
    /** Uppy `ThumbnailGenerator` preview object — uploaded to S3 but never ingested. */
    readonly isThumbnail: boolean;
}

const TTL_SECONDS = 24 * 60 * 60;

/** Single source of truth for the stash key shape (`companion:upload-meta:<brand>:<uploadId>`). */
export const buildUploadMetaKey = (brandSlug: string, uploadId: string): string =>
    `companion:upload-meta:${brandSlug}:${uploadId}`;

/**
 * Best-effort stash — a Redis blip must never fail the upload create (the
 * complete handler degrades gracefully on a missing stash). Returns whether
 * the write succeeded, for the caller to log if it cares.
 */
export const stashUploadMeta = async (
    brandSlug: string,
    uploadId: string,
    meta: UploadMeta,
): Promise<boolean> => {
    try {
        await getRedis().set(buildUploadMetaKey(brandSlug, uploadId), JSON.stringify(meta), 'EX', TTL_SECONDS);
        return true;
    } catch (err) {
        logger.warn({ err, brand: brandSlug }, '[upload-meta] stash write failed (upload proceeds; complete will degrade)');
        return false;
    }
};

/** Reads + parses the stash, or `null` on miss/expiry/Redis-error/corrupt-JSON. */
export const readUploadMeta = async (brandSlug: string, uploadId: string): Promise<UploadMeta | null> => {
    try {
        const raw = await getRedis().get(buildUploadMetaKey(brandSlug, uploadId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as UploadMeta;
        return parsed;
    } catch (err) {
        logger.warn({ err, brand: brandSlug }, '[upload-meta] stash read failed');
        return null;
    }
};

/** Best-effort delete after a successful read — the TTL is the backstop. */
export const deleteUploadMeta = async (brandSlug: string, uploadId: string): Promise<void> => {
    try {
        await getRedis().del(buildUploadMetaKey(brandSlug, uploadId));
    } catch (err) {
        logger.warn({ err, brand: brandSlug }, '[upload-meta] stash delete failed (TTL will reclaim)');
    }
};
