import {
    PutObjectCommand,
    UploadPartCommand,
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    ListPartsCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../../core/types/express.js';
import { buildS3Key } from './s3.key-builder.js';

// --- Helpers ---

const validatePartNumber = (partNumber: any): boolean => {
    const n = Number(partNumber);
    return Number.isInteger(n) && n >= 1 && n <= 10000;
};

const isValidPart = (part: any) => {
    return (
        part &&
        typeof part === 'object' &&
        Number(part.PartNumber) &&
        typeof part.ETag === 'string'
    );
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
            console.error('[s3] Missing brand S3 config');
            res.status(400).json({ error: 'Configuración S3 incompleta para esta marca' });
            return;
        }

        // Support GET (query) and POST (body)
        const isPost = req.method === 'POST';
        const params = isPost ? req.body : req.query;
        const filename = params.filename as string;
        const contentType = (params.contentType || params.type) as string;

        if (!filename || !contentType) {
            res.status(400).json({ error: 'Falta filename o contentType' });
            return;
        }

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
        console.error('[s3] Error signing URL:', error);
        res.status(500).json({ error: 'Error firmando subida' });
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
        console.error('[s3] Error adding multipart:', error);
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
        console.error('[s3] Error signing part:', error);
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

        const parts: any[] = [];
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
        console.error('[s3] Error listing parts:', error);
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
        console.error('[s3] Error completing multipart:', error);
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

        const command = new AbortMultipartUploadCommand({
            Bucket: brand.s3.bucket,
            Key: key,
            UploadId: uploadId,
        });

        await brand.s3.client.send(command);

        res.status(200).json({});
    } catch (error) {
        console.error('[s3] Error aborting multipart:', error);
        res.status(500).json({ error: 'Error aborting multipart' });
    }
};
