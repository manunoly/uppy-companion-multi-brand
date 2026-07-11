import {
    PutObjectCommand,
    UploadPartCommand,
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    HeadObjectCommand,
    ListPartsCommand,
    type Part,
    type CompletedPart
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../../core/types/express.js';
import type { Brand } from '../../brand/brand.types.js';
import { buildS3Key, buildUserKeyPrefix } from './s3.key-builder.js';
import { resolveValidatedIngestTarget, readIngestToken } from '../../brand/identity.js';
import { postIngest } from '../ingest/ingest.client.js';
import { stashUploadMeta, readUploadMeta, deleteUploadMeta, type UploadMeta } from '../ingest/upload-meta.store.js';
import { logger } from '../../../lib/logger.js';

// --- Helpers ---

/**
 * Parses a client-declared size (e.g. `?contentLength=123`) into a POSITIVE
 * INTEGER number of bytes, or `undefined` when absent/unparseable/invalid.
 * Browsers forbid scripts from setting the real `Content-Length` header, so
 * the client declares the size of the file it INTENDS to upload as an
 * ordinary field instead. Negative, fractional or zero values are malformed
 * as a byte count and are treated as "not declared" (undefined) so the
 * limit check stays consistent — a `-1` must never sneak past `> maxUploadBytes`.
 */
export const parseDeclaredLength = (raw: unknown): number | undefined => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * D14 (H13, partial closure): rejects a signing request whose CLIENT-DECLARED
 * size/type falls outside the brand's configured limits.
 *
 * This is declarative only: signS3/signPart sign a PUT by query string
 * (SigV4), not a presigned POST, so S3 itself never enforces
 * `content-length-range` — a dishonest client can still send a different
 * real size/type to the signed URL. Real server-side enforcement requires
 * migrating to presigned POST (Fase 8, spec D14/8.5). Absence of a declared
 * value is not itself an error (older/undeclaring clients still work) — it
 * simply means this check has nothing to validate.
 */
const rejectIfOutsideLimits = (
    brand: Brand,
    declared: { contentLength?: number; contentType?: string },
    res: Response,
): boolean => {
    const { maxUploadBytes, allowedContentTypes } = brand.limits;

    if (declared.contentLength !== undefined && declared.contentLength > maxUploadBytes) {
        res.status(400).json({
            error: `s3: declared Content-Length exceeds the ${maxUploadBytes}-byte limit for this brand`,
        });
        return true;
    }

    if (
        allowedContentTypes &&
        declared.contentType !== undefined &&
        !allowedContentTypes.includes(declared.contentType)
    ) {
        res.status(400).json({ error: 's3: Content-Type not allowed for this brand' });
        return true;
    }

    return false;
};

/** Parses a client-supplied `folderId` into a positive integer, or `null`. */
export const parseFolderId = (raw: unknown): number | null => {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Operator signal for a completed-but-not-ingested upload (Phase-1 residual,
 * C-3): the S3 object exists but produced no `uploads` library row. Emitted as
 * a single stable structured warn (`event: 'upload-ingested-false'`) that
 * alerting/log-based metrics key on; `reason` separates accepted rejections
 * (`over-limit`/`mime-not-allowed` — do NOT re-ingest) from ingest failures
 * (partner 5xx/timeout/misconfig — reconcile candidates).
 *
 * Manual reconcile (no durable worker this round — SQS DEFERRED): list
 * `original/<userId>/*` S3 keys, diff against the partner's `uploads` table,
 * and re-POST the ingest endpoint (P1-M2) for the legit `reason`-less/failure
 * orphans only.
 */
const recordIngestedFalse = (brandSlug: string, key: string, reason: string): void => {
    logger.warn(
        { brand: brandSlug, key, reason, event: 'upload-ingested-false' },
        '[ingest] upload completed but not ingested (Phase-1 residual; manual reconcile)',
    );
};

// S3 multipart contract: PartNumber must be an integer in [1, 10000].
const isPartNumberInRange = (n: number): boolean =>
    Number.isInteger(n) && n >= 1 && n <= 10000;

const validatePartNumber = (partNumber: string): boolean =>
    isPartNumberInRange(Number(partNumber));

const isValidPart = (part: unknown): part is CompletedPart => {
    if (typeof part !== 'object' || part === null) return false;
    const p = part as Record<string, unknown>;
    return isPartNumberInRange(Number(p.PartNumber)) && typeof p.ETag === 'string';
};

/**
 * Defense against BOLA (OWASP API1): a multipart endpoint receives `key` from
 * the client. Without this check, an authenticated user could request signing
 * for, list, complete, or abort an upload outside their own user/brand path.
 * AWS rejects mismatched uploadId+key pairs server-side, but the authoritative
 * authorization gate must live here, in OUR code.
 */
const sendIfKeyNotOwned = (req: AppRequest, key: string, res: Response): boolean => {
    if (!req.brand) {
        res.status(400).json({ error: 's3: brand not resolved' });
        return true;
    }
    if (!req.user?.id) {
        res.status(401).json({ error: 's3: user not authenticated' });
        return true;
    }
    // Note: no `..` check here. S3 keys are flat strings to S3 (no path
    // resolution), and `sanitizeFilename` allows dots so legitimate filenames
    // like `weird..file.jpg` produce keys containing `..`. The authoritative
    // gate is the per-user prefix below.
    const prefix = buildUserKeyPrefix(req.brand, req.user);
    if (!key.startsWith(prefix)) {
        res.status(403).json({ error: 's3: key does not belong to authenticated user' });
        return true;
    }
    return false;
};

// --- Controllers ---

/**
 * Handle simple S3 upload signing (PutObject).
 * Supports both GET (query) and POST (body) parameters.
 */
export const signS3 = async (req: AppRequest, res: Response, _next: NextFunction): Promise<void> => {
    try {
        const brand = req.brand;
        if (!brand || !brand.s3.client || !brand.s3.bucket) {
            logger.error({ brand: brand?.slug }, '[s3] Missing brand S3 config');
            res.status(400).json({ error: 'S3 configuration incomplete for this brand' });
            return;
        }

        // Support GET (query) and POST (body)
        const isPost = req.method === 'POST';
        const params = isPost ? req.body : req.query;
        const filename = params.filename as string;
        const contentType = (params.contentType || params.type) as string;

        if (!filename || !contentType) {
            res.status(400).json({ error: 'Missing filename or contentType' });
            return;
        }

        const declaredLength = parseDeclaredLength(params.contentLength ?? params.size);
        if (rejectIfOutsideLimits(brand, { contentLength: declaredLength, contentType }, res)) return;

        const key = buildS3Key({ req, filename, metadata: req.body?.metadata });

        const command = new PutObjectCommand({
            Bucket: brand.s3.bucket,
            Key: key,
            ContentType: contentType,
            // ACL removed to respect bucket policies (Legacy behavior)
        });

        // Use getSignedUrl from presigner
        const url = await getSignedUrl(brand.s3.client, command, { expiresIn: 300 });

        res.json({
            method: 'PUT',
            url,
            fields: {},
        });
    } catch (error) {
        logger.error({ err: error, brand: req.brand?.slug }, '[s3] Error signing URL');
        res.status(500).json({ error: 'Error signing upload' });
    }
};

/**
 * Handle multipart upload creation
 */
export const createMultipartUpload = async (req: AppRequest, res: Response, _next: NextFunction): Promise<void> => {
    try {
        const brand = req.brand;
        if (!brand || !brand.s3.client || !brand.s3.bucket) {
            res.status(400).json({ error: 'Missing S3 config' });
            return;
        }

        const { filename, type, metadata } = req.body;
        if (typeof filename !== 'string' || typeof type !== 'string') {
            res.status(400).json({ error: 's3: filename and type must be strings' });
            return;
        }

        // P1: with multipart-for-all (uppyModal.ts shouldUseMultipart -> true),
        // the client now declares its post-compression byte size at create so
        // an obviously over-limit upload is rejected up front, alongside the
        // existing Content-Type allowlist check. This is DECLARATIVE only — the
        // authoritative size gate is the HeadObject check on complete (a
        // dishonest client can still declare a small size). Absence of a
        // declared size is not an error (older clients still work).
        const declaredLength = parseDeclaredLength(req.body.size ?? req.body.contentLength);
        if (rejectIfOutsideLimits(brand, { contentLength: declaredLength, contentType: type }, res)) return;

        const key = buildS3Key({ req, filename, metadata });

        const command = new CreateMultipartUploadCommand({
            Bucket: brand.s3.bucket,
            Key: key,
            ContentType: type,
            ServerSideEncryption: 'AES256', // Q6/H24: cifrado en reposo forzado (defensa en profundidad); heredado por todas las partes
            // ACL removed to respect bucket policies
        });

        const s3Data = await brand.s3.client.send(command);
        const uploadId = s3Data.UploadId;

        // Stash the values the complete handler needs (folder, declared size,
        // thumbnail flag), keyed by uploadId. `userId` is the server-validated
        // identity, never client meta. Best-effort: a Redis blip must not fail
        // the upload — complete degrades gracefully on a missing stash.
        if (uploadId && req.user?.id) {
            const meta: UploadMeta = {
                filename,
                mimetype: type,
                declaredSize: declaredLength ?? null,
                folderId: parseFolderId(req.body.folderId),
                userId: req.user.id,
                isThumbnail: req.body.isThumbnail === 'true',
            };
            await stashUploadMeta(brand.slug, uploadId, meta);
        }

        res.json({
            key: s3Data.Key,
            uploadId,
        });
    } catch (error) {
        logger.error({ err: error, brand: req.brand?.slug }, '[s3] Error adding multipart');
        res.status(500).json({ error: 'Error initiating multipart upload' });
    }
};

/**
 * Handle signing a part
 */
export const signPart = async (req: AppRequest, res: Response, _next: NextFunction): Promise<void> => {
    try {
        const brand = req.brand;
        if (!brand || !brand.s3.client || !brand.s3.bucket) {
            res.status(400).json({ error: 'Missing S3 config' });
            return;
        }

        const { uploadId, partNumber } = req.params;
        const { key } = req.query;

        if (!validatePartNumber(partNumber)) {
            res.status(400).json({ error: 's3: the part number must be an integer between 1 and 10000.' });
            return;
        }
        if (typeof key !== 'string') {
            res.status(400).json({ error: 's3: the object key must be passed as a query parameter.' });
            return;
        }
        if (sendIfKeyNotOwned(req, key, res)) return;

        const declaredLength = parseDeclaredLength(req.query.contentLength ?? req.query.size);
        if (rejectIfOutsideLimits(brand, { contentLength: declaredLength }, res)) return;

        const command = new UploadPartCommand({
            Bucket: brand.s3.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: parseInt(partNumber, 10),
            Body: '', // Body is required in types but ignored for signing
        });

        const expiresIn = 300;
        const url = await getSignedUrl(brand.s3.client, command, { expiresIn });

        res.json({ url, expires: expiresIn });
    } catch (error) {
        logger.error({ err: error, brand: req.brand?.slug }, '[s3] Error signing part');
        res.status(500).json({ error: 'Error signing part' });
    }
};

/**
 * Handle listing parts (essential for resuming uploads)
 */
export const listParts = async (req: AppRequest, res: Response, _next: NextFunction): Promise<void> => {
    try {
        const brand = req.brand;
        if (!brand || !brand.s3.client || !brand.s3.bucket) {
            res.status(400).json({ error: 'Missing S3 config' });
            return;
        }

        const { uploadId } = req.params;
        const { key } = req.query;

        if (typeof key !== 'string') {
            res.status(400).json({ error: 's3: the object key must be passed as a query parameter.' });
            return;
        }
        if (sendIfKeyNotOwned(req, key, res)) return;

        const parts: Part[] = [];
        let nextMarker: string | undefined;
        let isTruncated = true;

        // Pagination loop
        while (isTruncated) {
            const command = new ListPartsCommand({
                Bucket: brand.s3.bucket,
                Key: key,
                UploadId: uploadId,
                PartNumberMarker: nextMarker
            });

            const data = await brand.s3.client.send(command);

            if (data.Parts) {
                parts.push(...data.Parts);
            }

            isTruncated = data.IsTruncated ?? false;
            nextMarker = data.NextPartNumberMarker;
        }

        res.json(parts);
    } catch (error) {
        logger.error({ err: error, brand: req.brand?.slug }, '[s3] Error listing parts');
        res.status(500).json({ error: 'Error listing parts' });
    }
};

/**
 * Handle completing multipart upload — plus the Phase-1 wire contract: after
 * S3 finalizes the object, enforce the size/MIME LIBRARY boundary via
 * HeadObject and forward the file to the partner's ingest endpoint inline.
 *
 * Ordering matters: once CompleteMultipartUploadCommand succeeds the object
 * exists and the multipart upload is consumed, so EVERY subsequent step
 * (HeadObject, ingest) must resolve to `200` — a non-2xx would make Uppy retry
 * CompleteMultipartUpload against an already-completed upload (S3 NoSuchUpload).
 * The inner try enforces that invariant.
 */
export const completeMultipartUpload = async (req: AppRequest, res: Response, _next: NextFunction): Promise<void> => {
    const brand = req.brand;
    if (!brand || !brand.s3.client || !brand.s3.bucket) {
        res.status(400).json({ error: 'Missing S3 config' });
        return;
    }

    const { uploadId } = req.params;
    const { key } = req.query;
    const { parts } = req.body;

    if (typeof key !== 'string') {
        res.status(400).json({ error: 's3: the object key must be passed as a query parameter.' });
        return;
    }
    if (sendIfKeyNotOwned(req, key, res)) return;
    const userId = req.user?.id;
    if (!userId) {
        res.status(401).json({ error: 's3: user not authenticated' });
        return;
    }
    if (!Array.isArray(parts) || !parts.every(isValidPart)) {
        res.status(400).json({ error: 's3: `parts` must be an array of {ETag, PartNumber} objects.' });
        return;
    }

    const s3 = brand.s3.client;
    const bucket = brand.s3.bucket;

    let location: string | undefined;
    try {
        const data = await s3.send(new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
        }));
        location = data.Location;
    } catch (error) {
        // The multipart upload was NOT consumed — a retry is legitimate.
        logger.error({ err: error, brand: brand.slug }, '[s3] Error completing multipart');
        res.status(500).json({ error: 'Error completing multipart' });
        return;
    }

    // Post-complete: the object now exists. Never throw out of here — always 200.
    try {
        const meta = await readUploadMeta(brand.slug, uploadId);
        await deleteUploadMeta(brand.slug, uploadId);

        // Thumbnails (Uppy ThumbnailGenerator previews) land in S3 but are never
        // a library asset — parity with the removed client-side upload-success skip.
        if (meta?.isThumbnail) {
            res.json({ location, ingested: false });
            return;
        }

        // Authoritative size/type — catches a client that declared a small size
        // at create then uploaded more across parts. X-1 owner decision: an
        // over-limit object is NOT deleted (no s3:DeleteObject); the limit is
        // enforced at the LIBRARY boundary (it never enters `uploads`).
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const actualSize = head.ContentLength ?? 0;
        const actualType = head.ContentType ?? meta?.mimetype ?? '';
        const { maxUploadBytes, allowedContentTypes } = brand.limits;

        if (actualSize > maxUploadBytes) {
            recordIngestedFalse(brand.slug, key, 'over-limit');
            res.json({ location, ingested: false, rejected: 'over-limit' });
            return;
        }
        if (allowedContentTypes && actualType && !allowedContentTypes.includes(actualType)) {
            recordIngestedFalse(brand.slug, key, 'mime-not-allowed');
            res.json({ location, ingested: false, rejected: 'mime-not-allowed' });
            return;
        }

        // Brand without an ingest callback (e.g. edo) — no library to notify.
        // Not an orphan needing reconcile, so no operator metric.
        if (!brand.ingest) {
            res.json({ location, ingested: false });
            return;
        }

        // Fetch through the SSRF-validated URL, never brand.ingest.url directly.
        const target = resolveValidatedIngestTarget(brand);
        if (!target.ok) {
            logger.error({ brand: brand.slug, reason: target.reason }, '[ingest] target rejected by SSRF gate');
            recordIngestedFalse(brand.slug, key, `target:${target.reason}`);
            res.json({ location, ingested: false });
            return;
        }

        let token: string;
        try {
            token = readIngestToken(brand.ingest.tokenEnv).trim();
        } catch (err) {
            logger.error({ err, brand: brand.slug }, '[ingest] token misconfigured');
            recordIngestedFalse(brand.slug, key, 'token-misconfigured');
            res.json({ location, ingested: false });
            return;
        }

        const filename = meta?.filename ?? key.split('/').pop() ?? 'untitled';
        const result = await postIngest({
            url: target.url,
            token,
            userId,
            brandSlug: brand.slug,
            caller: 'companion',
            files: [{
                key,
                filename,
                mimetype: actualType,
                fileSize: actualSize,
                ...(meta?.folderId != null ? { folderId: meta.folderId } : {}),
                source: 'local',
            }],
        });

        const ingested = result.ok && result.uploads.length > 0;
        if (!ingested) {
            recordIngestedFalse(brand.slug, key, result.ok ? 'skipped-by-partner' : result.reason);
            res.json({ location, ingested: false });
            return;
        }

        // X-2: forward capsule's uploads UNCHANGED (Companion cannot invent the
        // final URL — capsule may apply AWS_PUBLIC_BUCKET_BASE_URL).
        res.json({ location, ingested: true, uploads: result.uploads });
    } catch (error) {
        logger.error({ err: error, brand: brand.slug }, '[s3] Post-complete ingest step failed');
        recordIngestedFalse(brand.slug, key, 'post-complete-error');
        res.json({ location, ingested: false });
    }
};

/**
 * Handle aborting multipart upload
 */
export const abortMultipartUpload = async (req: AppRequest, res: Response, _next: NextFunction): Promise<void> => {
    try {
        const brand = req.brand;
        if (!brand || !brand.s3.client || !brand.s3.bucket) {
            res.status(400).json({ error: 'Missing S3 config' });
            return;
        }

        const { uploadId } = req.params;
        const { key } = req.query;

        if (typeof key !== 'string') {
            res.status(400).json({ error: 's3: the object key must be passed as a query parameter.' });
            return;
        }
        if (sendIfKeyNotOwned(req, key, res)) return;

        const command = new AbortMultipartUploadCommand({
            Bucket: brand.s3.bucket,
            Key: key,
            UploadId: uploadId,
        });

        await brand.s3.client.send(command);

        res.status(200).json({});
    } catch (error) {
        logger.error({ err: error, brand: req.brand?.slug }, '[s3] Error aborting multipart');
        res.status(500).json({ error: 'Error aborting multipart' });
    }
};
