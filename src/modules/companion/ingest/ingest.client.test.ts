import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postIngest, type IngestRequest } from './ingest.client.js';

/**
 * postIngest never reads brand config or a token env itself (identity.ts's
 * resolveValidatedIngestTarget/readIngestToken own that) — it only fetches
 * whatever URL/token the caller (s3.controller.ts) already resolved. These
 * tests exercise that boundary directly: the exact request it issues, and
 * that every failure mode collapses to {ok:false} rather than a throw (so the
 * complete handler can always answer 200, never make Uppy retry against an
 * already-completed multipart upload).
 */

const baseReq: IngestRequest = {
    url: new URL('https://abeduls.com/api/internal/media/ingest'),
    token: 'trimmed-token-value',
    userId: 'u123',
    brandSlug: 'abe',
    caller: 'companion',
    files: [{ key: 'original/u123/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg', fileSize: 2048, source: 'local' }],
};

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const statusResponse = (status: number) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

describe('postIngest — S2S ingest POST (P1-C-PROTOCOL wire contract)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('POSTs to exactly the URL the caller resolved (never derives its own target)', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        await postIngest(baseReq);
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0]).toBe(baseReq.url);
        expect((call[0] as URL).href).toBe('https://abeduls.com/api/internal/media/ingest');
    });

    it('sends Authorization: Bearer <token>, X-User-Id, X-Brand-Id (the resolved slug, never hardcoded) and X-Caller', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        await postIngest(baseReq);
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        const headers = call[1]?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer trimmed-token-value');
        expect(headers['X-User-Id']).toBe('u123');
        expect(headers['X-Brand-Id']).toBe('abe');
        expect(headers['X-Caller']).toBe('companion');
    });

    it('uses whatever brandSlug it is given, not a hardcoded "abe"', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        await postIngest({ ...baseReq, brandSlug: 'picaboo' });
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        const headers = call[1]?.headers as Record<string, string>;
        expect(headers['X-Brand-Id']).toBe('picaboo');
    });

    it('omits X-Caller entirely when the caller is not provided', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        const reqWithoutCaller: IngestRequest = {
            url: baseReq.url,
            token: baseReq.token,
            userId: baseReq.userId,
            brandSlug: baseReq.brandSlug,
            files: baseReq.files,
        };
        await postIngest(reqWithoutCaller);
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        const headers = call[1]?.headers as Record<string, string>;
        expect(headers['X-Caller']).toBeUndefined();
    });

    it('does not trim the token itself — trimming is the caller (readIngestToken)\'s job', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        await postIngest({ ...baseReq, token: '  untrimmed  ' });
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        const headers = call[1]?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer   untrimmed  ');
    });

    it('sends the {files:[...]} body shape verbatim, as JSON', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        await postIngest(baseReq);
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(JSON.parse(call[1]?.body as string)).toEqual({ files: baseReq.files });
        expect(call[1]?.headers as Record<string, string>).toMatchObject({ 'Content-Type': 'application/json' });
    });

    it('never follows a redirect off the validated host (redirect: manual)', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        await postIngest(baseReq);
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[1]?.redirect).toBe('manual');
    });

    it('bounds every attempt with a ~3s AbortSignal.timeout', async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        await postIngest(baseReq);
        expect(timeoutSpy).toHaveBeenCalledWith(3000);
    });

    it('resolves {ok:true, uploads} on a successful response', async () => {
        const uploads = [{ id: 1, url: 'https://cdn/f.jpg', filename: 'f.jpg', mimetype: 'image/jpeg' }];
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true, uploads }));
        const result = await postIngest(baseReq);
        expect(result).toEqual({ ok: true, uploads });
    });

    it('defaults uploads to [] when the success response omits the field', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okResponse({ success: true }));
        const result = await postIngest(baseReq);
        expect(result).toEqual({ ok: true, uploads: [] });
    });

    it('resolves {ok:false, reason:"not-success"} when success is not exactly true (retried once, same result both times)', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse({ success: false }));
        const result = await postIngest(baseReq);
        expect(result).toEqual({ ok: false, reason: 'not-success' });
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries exactly once on a non-2xx status, then succeeds', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce(statusResponse(500))
            .mockResolvedValueOnce(okResponse({ success: true, uploads: [] }));
        const result = await postIngest(baseReq);
        expect(result).toEqual({ ok: true, uploads: [] });
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('gives up after exactly one retry (2 attempts total) on a persistent 5xx, never throwing', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(statusResponse(500));
        const result = await postIngest(baseReq);
        expect(result).toEqual({ ok: false, reason: 'status-500' });
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('resolves {ok:false} (never throws) when fetch itself rejects (network error/timeout), after one retry', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
        const result = await postIngest(baseReq);
        expect(result).toEqual({ ok: false, reason: 'Error' });
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('resolves {ok:false, reason:"invalid-json"} when the response body cannot be parsed (retried once, same result both times)', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('bad json');
            },
        } as unknown as Response);
        const result = await postIngest(baseReq);
        expect(result).toEqual({ ok: false, reason: 'invalid-json' });
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
});
