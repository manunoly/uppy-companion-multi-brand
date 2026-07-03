import { Router } from 'express';
import * as s3Controller from './s3/s3.controller.js';
import { requireAuth } from '../auth/index.js';

const router = Router();

// All S3 endpoints require an authenticated user (resolveSession — Fase 3).
// `requireAuth` (modules/auth/auth.middleware.ts) returns 401 for no/invalid
// session, 503 when the brand's whoami partner is unavailable (breaker open/
// timeout/5xx), and 403 when the brand's auth config itself is misconfigured
// (e.g. an off-allowlist whoamiUrl) — uploads can never be attributed to an
// unverified identity.
router.use(requireAuth);

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

