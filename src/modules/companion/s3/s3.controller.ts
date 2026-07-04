import {
    PutObjectCommand,
    UploadPartCommand,
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    ListPartsCommand,
    type Part,
    type CompletedPart
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../../core/types/express.js';
import type { Brand } from '../../brand/brand.types.js';
import { buildS3Key, buildUserKeyPrefix } from './s3.key-builder.js';
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

        // MEDIO-2 (security audit): validate the client-declared Content-Type
        // against the brand's allowlist, same helper/behavior as signS3.
        // KNOWN LIMITATION (deferred to Fase 8, spec D14/8.5): byte-size
        // limits are intentionally NOT enforced here. Unlike signS3, the
        // client never declares a size anywhere in the multipart flow
        // (createMultipartUpload/signPart both omit it), and signPart signs a
        // plain SigV4 PUT-by-query-string per part — there is no
        // `content-length-range` mechanism for that, unlike a presigned POST.
        // Real server-side byte enforcement for multipart requires migrating
        // to presigned POST, which is out of scope here (uppyModal.ts is
        // browser-only, H21).
        if (rejectIfOutsideLimits(brand, { contentType: type }, res)) return;

        const key = buildS3Key({ req, filename, metadata });

        const command = new CreateMultipartUploadCommand({
            Bucket: brand.s3.bucket,
            Key: key,
            ContentType: type,
            // ACL removed to respect bucket policies
        });

        const s3Data = await brand.s3.client.send(command);

        res.json({
            key: s3Data.Key,
            uploadId: s3Data.UploadId,
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
 * Handle completing multipart upload
 */
export const completeMultipartUpload = async (req: AppRequest, res: Response, _next: NextFunction): Promise<void> => {
    try {
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
        if (!Array.isArray(parts) || !parts.every(isValidPart)) {
            res.status(400).json({ error: 's3: `parts` must be an array of {ETag, PartNumber} objects.' });
            return;
        }

        const command = new CompleteMultipartUploadCommand({
            Bucket: brand.s3.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
        });

        const data = await brand.s3.client.send(command);

        res.json({
            location: data.Location,
        });
    } catch (error) {
        logger.error({ err: error, brand: req.brand?.slug }, '[s3] Error completing multipart');
        res.status(500).json({ error: 'Error completing multipart' });
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
