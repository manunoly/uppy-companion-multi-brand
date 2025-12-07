import { Router } from 'express';
import * as s3Controller from './s3/s3.controller.js';

const router = Router();

// Simple S3 signing (supports GET and POST)
router.get('/uppy/sign-s3', s3Controller.signS3);
router.post('/uppy/sign-s3', s3Controller.signS3);

// Multipart S3 uploads
// 1. Create
router.post('/uppy/s3/multipart', s3Controller.createMultipartUpload);

// 2. Sign Part
router.get('/uppy/s3/multipart/:uploadId/:partNumber', s3Controller.signPart);

// 3. List Parts (Resume support)
router.get('/uppy/s3/multipart/:uploadId', s3Controller.listParts);

// 4. Complete
router.post('/uppy/s3/multipart/:uploadId/complete', s3Controller.completeMultipartUpload);

// 5. Abort
router.delete('/uppy/s3/multipart/:uploadId', s3Controller.abortMultipartUpload);

export const apiRouter: Router = router;

