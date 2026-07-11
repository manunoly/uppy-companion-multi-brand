import { logger } from '../../../lib/logger.js';

/**
 * S2S client for the partner's media-ingest endpoint (P1-M2 contract:
 * `POST <ingest.url>` with `Authorization: Bearer`, `X-User-Id`, `X-Brand-Id`,
 * optional `X-Caller`; body `{ files:[{ key, filename, mimetype, fileSize,
 * folderId?, source? }] }`; response `{ success, uploads, skipped }`).
 *
 * SSRF posture: the caller MUST pass the URL already resolved through
 * `resolveValidatedIngestTarget` (identity.ts) and the token already resolved
 * through `readIngestToken` and trimmed — this module never reads the brand
 * config or the token env itself, so an off-allowlist target or an untrimmed
 * secret can never originate here.
 */

export interface IngestFile {
    readonly key: string;
    readonly filename: string;
    readonly mimetype: string;
    readonly fileSize: number;
    readonly folderId?: number;
    readonly source?: string;
}

export interface IngestUpload {
    readonly id: string | number;
    readonly url: string;
    readonly filename: string;
    readonly mimetype: string;
}

export interface IngestRequest {
    readonly url: URL;
    /** Already resolved via readIngestToken and trimmed by the caller. */
    readonly token: string;
    readonly userId: string;
    readonly brandSlug: string;
    readonly caller?: string;
    readonly files: readonly IngestFile[];
}

export type IngestResult =
    | { ok: true; uploads: IngestUpload[]; skipped?: readonly unknown[] }
    | { ok: false; reason: string };

const TIMEOUT_MS = 3000;

const attemptIngest = async (req: IngestRequest): Promise<IngestResult> => {
    let response: Response;
    try {
        response = await fetch(req.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${req.token}`,
                'X-User-Id': req.userId,
                'X-Brand-Id': req.brandSlug,
                ...(req.caller ? { 'X-Caller': req.caller } : {}),
            },
            body: JSON.stringify({ files: req.files }),
            // Mirror folders.service.ts: never follow a 3xx off the validated
            // host — the SSRF gate only vetted the initial URL.
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.name : 'network-error' };
    }

    if (!response.ok) {
        return { ok: false, reason: `status-${response.status}` };
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return { ok: false, reason: 'invalid-json' };
    }

    const parsed = body as { success?: unknown; uploads?: unknown; skipped?: unknown };
    if (parsed.success !== true) {
        return { ok: false, reason: 'not-success' };
    }
    const uploads = Array.isArray(parsed.uploads) ? (parsed.uploads as IngestUpload[]) : [];
    if (Array.isArray(parsed.skipped)) {
        return { ok: true, uploads, skipped: parsed.skipped };
    }
    return { ok: true, uploads };
};

/**
 * Bounded ingest POST: one immediate retry on failure (~3s timeout each).
 * Never throws — every failure mode collapses to `{ ok: false, reason }` so
 * the complete handler can respond `200 { ingested:false }` and leave the S3
 * object intact (a non-2xx would make Uppy retry CompleteMultipartUpload ->
 * S3 NoSuchUpload).
 */
export const postIngest = async (req: IngestRequest): Promise<IngestResult> => {
    const first = await attemptIngest(req);
    if (first.ok) return first;

    logger.warn({ brand: req.brandSlug, reason: first.reason }, '[ingest] first attempt failed, retrying once');
    return attemptIngest(req);
};
