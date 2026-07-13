import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * uppyModal.ts is a browser bundle (`@ts-nocheck`, imports the Uppy SDK from
 * from npm packages) bundled by scripts/build-assets.mjs — it
 * is excluded from coverage (vitest.config.ts) because most of it only runs
 * in a real DOM. The factory body itself (plugin registration, Dashboard
 * options, `restrictions`), though, has no DOM dependency as long as the
 * GOOGLE_* and enableThumbnails options are all supplied (see
 * NODE_SAFE_OPTIONS below) — mocking the package specifiers lets it run under
 * Vitest. `shouldUseMultipart` pins the P1-C-PROTOCOL deviation from Uppy's
 * default (single PUT under 100 MiB, multipart above) — EVERY file goes
 * through multipart now, tiny images included, because
 * completeMultipartUpload is the only universal server completion hook.
 */

interface FakePluginRegistration {
    plugin: string;
    opts?: Record<string, unknown>;
}

class FakeUppy {
    plugins: FakePluginRegistration[] = [];
    constructorOptions: Record<string, unknown>;
    // P1-C9: the live set-theme handler calls uppy.getPlugin('Dashboard').setOptions(...).
    dashboardPlugin = { setOptions: vi.fn() };
    handlers: Record<string, (...args: unknown[]) => unknown> = {};
    addFile = vi.fn();
    constructor(constructorOptions: Record<string, unknown> = {}) {
        this.constructorOptions = constructorOptions;
    }
    use(plugin: string, opts?: Record<string, unknown>): FakeUppy {
        this.plugins.push({ plugin, opts });
        return this;
    }
    on(event: string, handler: (...args: unknown[]) => unknown): FakeUppy {
        this.handlers[event] = handler;
        return this;
    }
    setMeta(_meta: Record<string, unknown>): FakeUppy {
        return this;
    }
    getPlugin(name: string): { setOptions: (opts: Record<string, unknown>) => void } | undefined {
        return name === 'Dashboard' ? this.dashboardPlugin : undefined;
    }
}

type FetchInit = { headers: Record<string, string>; body: string };
type MultipartData = { key: string; uploadId: string; parts?: unknown[] };
type CompleteFn = (file: { name: string; type: string }, data: MultipartData, signal: AbortSignal) => Promise<unknown>;
type CreateFn = (file: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
type ListPartsFn = (file: { name: string }, data: MultipartData, signal: AbortSignal) => Promise<unknown>;

/** Extracts the registered AwsS3 plugin options (getUploadParameters, create/complete/listParts). */
const getAwsOpts = (uppy: FakeUppy): Record<string, unknown> => {
    const registration = uppy.plugins.find((r) => r.plugin === 'AwsS3');
    if (!registration?.opts) throw new Error('AwsS3 plugin not registered');
    return registration.opts;
};

vi.mock('@uppy/core', () => ({ default: FakeUppy }));
vi.mock('@uppy/dashboard', () => ({ default: 'Dashboard' }));
vi.mock('@uppy/facebook', () => ({ default: 'Facebook' }));
vi.mock('@uppy/dropbox', () => ({ default: 'Dropbox' }));
vi.mock('@uppy/google-drive', () => ({ default: 'GoogleDrive' }));
vi.mock('@uppy/instagram', () => ({ default: 'Instagram' }));
vi.mock('@uppy/onedrive', () => ({ default: 'OneDrive' }));
vi.mock('@uppy/box', () => ({ default: 'Box' }));
vi.mock('@uppy/unsplash', () => ({ default: 'Unsplash' }));
vi.mock('@uppy/zoom', () => ({ default: 'Zoom' }));
vi.mock('@uppy/url', () => ({ default: 'Url' }));
vi.mock('@uppy/google-drive-picker', () => ({ default: 'GoogleDrivePicker' }));
vi.mock('@uppy/google-photos-picker', () => ({ default: 'GooglePhotosPicker' }));
vi.mock('@uppy/thumbnail-generator', () => ({ default: 'ThumbnailGenerator' }));
vi.mock('@uppy/compressor', () => ({ default: 'Compressor' }));
vi.mock('@uppy/image-editor', () => ({ default: 'ImageEditor' }));
vi.mock('@uppy/aws-s3', () => ({ default: 'AwsS3' }));
vi.mock('@uppy/core/css/style.min.css', () => ({}));
vi.mock('@uppy/dashboard/css/style.min.css', () => ({}));
vi.mock('@uppy/url/css/style.min.css', () => ({}));
vi.mock('@uppy/image-editor/css/style.min.css', () => ({}));

const NODE_SAFE_OPTIONS = {
    plugins: [],
    enableThumbnails: false,
    GOOGLE_API_KEY_DRIVE: '',
    GOOGLE_API_KEY_PHOTOS: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_APP_ID: '',
};

interface FakeClassList {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
}

interface FakeWindow {
    location: { search: string };
    addEventListener: (type: string, handler: (event: { origin: string; data: unknown }) => void) => void;
    parent: { postMessage: (data: unknown, targetOrigin: string) => void };
}

interface FakeDocument {
    documentElement: { classList: FakeClassList };
    body: { dataset: Record<string, string> };
    referrer: string;
    getElementById: (id: string) => null;
}

type BrowserGlobals = { window?: FakeWindow; document?: FakeDocument };

/**
 * P1-C9's theme code (window.location.search read, documentElement.classList
 * mutation, the `message` listener) is `typeof window/document`-guarded so
 * the factory otherwise stays node-safe (see file header). These tests need
 * those branches live, so they install a minimal hand-rolled shim — not
 * jsdom/happy-dom, which aren't dependencies of this package — just enough
 * surface for the guards to see `typeof window/document !== 'undefined'`.
 */
const installFakeBrowserGlobals = (search: string, referrer = '') => {
    const classes = new Set<string>();
    let messageListener: ((event: { origin: string; data: unknown }) => void) | undefined;
    const postMessage = vi.fn();

    const fakeWindow: FakeWindow = {
        location: { search },
        addEventListener: (type, handler) => {
            if (type === 'message') messageListener = handler;
        },
        parent: { postMessage },
    };
    const fakeDocument: FakeDocument = {
        documentElement: {
            classList: {
                add: (...names) => names.forEach((name) => classes.add(name)),
                remove: (...names) => names.forEach((name) => classes.delete(name)),
            },
        },
        body: { dataset: {} },
        referrer,
        getElementById: () => null,
    };

    (globalThis as unknown as BrowserGlobals).window = fakeWindow;
    (globalThis as unknown as BrowserGlobals).document = fakeDocument;

    return {
        classes,
        postMessage,
        dispatchMessage: (event: { origin: string; data: unknown }) => messageListener?.(event),
    };
};

afterEach(() => {
    delete (globalThis as unknown as BrowserGlobals).window;
    delete (globalThis as unknown as BrowserGlobals).document;
});

describe('uppyModal — shouldUseMultipart (P1-C-PROTOCOL multipart-for-all deviation)', () => {
    it('registers AwsS3 with a shouldUseMultipart that returns true regardless of file size', async () => {
        const { default: uppyModal } = await import('./uppyModal.js');

        // GOOGLE_* options must be non-null so uppyModal's readOption() never
        // falls through to `document.getElementById` — this suite runs in
        // Vitest's node environment (no DOM).
        const uppy = uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy;

        const awsS3Registration = uppy.plugins.find((registration) => registration.plugin === 'AwsS3');
        expect(awsS3Registration).toBeDefined();

        const shouldUseMultipart = awsS3Registration?.opts?.shouldUseMultipart as (file: { size: number }) => boolean;
        expect(typeof shouldUseMultipart).toBe('function');
        expect(shouldUseMultipart({ size: 1024 })).toBe(true); // tiny file
        expect(shouldUseMultipart({ size: 6 * 1024 ** 3 })).toBe(true); // well above Uppy's 100 MiB default — still true
    });
});

describe('uppyModal — Dashboard visual parity + client restrictions (P1-C8)', () => {
    it('registers the Dashboard with ImageEditor in its plugin list, badge hidden, and designer-matching dimensions', async () => {
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy;

        const dashboardRegistration = uppy.plugins.find((registration) => registration.plugin === 'Dashboard');
        expect(dashboardRegistration).toBeDefined();
        expect(dashboardRegistration?.opts?.proudlyDisplayPoweredByUppy).toBe(false);
        expect(dashboardRegistration?.opts?.height).toBe(470);
        expect(dashboardRegistration?.opts?.width).toBe('100%');
        expect(dashboardRegistration?.opts?.plugins).toContain('ImageEditor');
    });

    it('registers Compressor and an ImageEditor targeting the Dashboard', async () => {
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy;

        expect(uppy.plugins.some((registration) => registration.plugin === 'Compressor')).toBe(true);

        const imageEditorRegistration = uppy.plugins.find((registration) => registration.plugin === 'ImageEditor');
        expect(imageEditorRegistration).toBeDefined();
        expect(imageEditorRegistration?.opts?.target).toBe('Dashboard');
    });

    it('sets client restrictions reconciled with abe server limits (C-4)', async () => {
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy;

        expect(uppy.constructorOptions.restrictions).toEqual({
            maxFileSize: 50 * 1024 * 1024,
            maxNumberOfFiles: 50,
            minNumberOfFiles: 1,
            allowedFileTypes: ['image/*', '.heic', '.HEIC', '.heif', '.HEIF'],
        });
    });
});

describe('uppyModal — resolveTheme (P1-C9 host-handed theme, no cookie)', () => {
    it('resolves the literal "dark" to dark', async () => {
        const { resolveTheme } = await import('./uppyModal.js');
        expect(resolveTheme('dark')).toBe('dark');
    });

    it('resolves the literal "light" to light', async () => {
        const { resolveTheme } = await import('./uppyModal.js');
        expect(resolveTheme('light')).toBe('light');
    });

    it('resolves an absent value (null or undefined) to light', async () => {
        const { resolveTheme } = await import('./uppyModal.js');
        expect(resolveTheme(null)).toBe('light');
        expect(resolveTheme(undefined)).toBe('light');
    });

    it('resolves an invalid value to light', async () => {
        const { resolveTheme } = await import('./uppyModal.js');
        expect(resolveTheme('blue')).toBe('light');
        expect(resolveTheme('')).toBe('light');
    });
});

describe('uppyModal — first-paint theme from `?theme=` (P1-C9)', () => {
    it('passes the resolved theme to the Dashboard option and stamps the root class, given ?theme=dark', async () => {
        const { classes } = installFakeBrowserGlobals('?theme=dark');
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy;

        const dashboardRegistration = uppy.plugins.find((registration) => registration.plugin === 'Dashboard');
        expect(dashboardRegistration?.opts?.theme).toBe('dark');
        expect(classes.has('dark')).toBe(true);
    });

    it('defaults to light when `?theme=` is absent', async () => {
        const { classes } = installFakeBrowserGlobals('');
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy;

        const dashboardRegistration = uppy.plugins.find((registration) => registration.plugin === 'Dashboard');
        expect(dashboardRegistration?.opts?.theme).toBe('light');
        expect(classes.has('light')).toBe(true);
    });
});

describe('uppyModal — live set-theme postMessage, origin-gated (P1-C9)', () => {
    const ALLOWED_ORIGIN = 'https://designer.abeduls.com';
    const FOREIGN_ORIGIN = 'https://evil.example.com';

    it('applies the theme via Dashboard.setOptions when set-theme arrives from an allowed ancestor', async () => {
        const { dispatchMessage } = installFakeBrowserGlobals('');
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED_ORIGIN] }) as unknown as FakeUppy;

        dispatchMessage({ origin: ALLOWED_ORIGIN, data: { type: 'set-theme', theme: 'dark' } });

        expect(uppy.dashboardPlugin.setOptions).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('ignores a set-theme message from a disallowed (foreign) origin', async () => {
        const { dispatchMessage } = installFakeBrowserGlobals('');
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED_ORIGIN] }) as unknown as FakeUppy;

        dispatchMessage({ origin: FOREIGN_ORIGIN, data: { type: 'set-theme', theme: 'dark' } });

        expect(uppy.dashboardPlugin.setOptions).not.toHaveBeenCalled();
    });

    it('ignores a non-set-theme message even from an allowed ancestor', async () => {
        const { dispatchMessage } = installFakeBrowserGlobals('');
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED_ORIGIN] }) as unknown as FakeUppy;

        dispatchMessage({ origin: ALLOWED_ORIGIN, data: { type: 'upload-complete', count: 1 } });

        expect(uppy.dashboardPlugin.setOptions).not.toHaveBeenCalled();
    });
});

// FIX 1: the multipart create/complete bodies used to be form-urlencoded via a
// `serialize()` helper that rendered arrays as `parts[]=[object Object]`, which
// express.urlencoded({extended:false}) parsed to `req.body.parts === undefined`
// → 400 on every complete. Both bodies now go out as JSON so a real `parts`
// array survives the wire. sign-s3 also carries JSON for consistency.
describe('uppyModal — S3 request bodies are JSON (FIX 1 wire contract)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('completeMultipartUpload sends Content-Type application/json and a body carrying the real parts array', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ location: 'l', ingested: true }) });
        vi.stubGlobal('fetch', fetchMock);
        const { default: uppyModal } = await import('./uppyModal.js');
        const opts = getAwsOpts(uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy);

        const parts = [{ ETag: '"abc"', PartNumber: 1 }];
        await (opts.completeMultipartUpload as CompleteFn)(
            { name: 'f.jpg', type: 'image/jpeg' },
            { key: 'original/u1/f.jpg', uploadId: 'up1', parts },
            new AbortController().signal,
        );

        const init = fetchMock.mock.calls[0][1] as FetchInit;
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(init.body)).toEqual({ parts });
    });

    it('createMultipartUpload sends Content-Type application/json and clean top-level fields', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'k', uploadId: 'up1' }) });
        vi.stubGlobal('fetch', fetchMock);
        const { default: uppyModal } = await import('./uppyModal.js');
        const opts = getAwsOpts(uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy);

        await (opts.createMultipartUpload as CreateFn)(
            { name: 'f.jpg', type: 'image/jpeg', size: 2048, meta: { folderId: '9' } },
            new AbortController().signal,
        );

        const init = fetchMock.mock.calls[0][1] as FetchInit;
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(init.body)).toMatchObject({ filename: 'f.jpg', type: 'image/jpeg', size: 2048, folderId: '9' });
    });
});

// FIX 2: listParts previously returned `data.parts` only, discarding the raw
// array the controller actually responds — resumed uploads never saw existing parts.
describe('uppyModal — listParts returns the raw server array (FIX 2)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the array response unchanged', async () => {
        const parts = [{ PartNumber: 1, ETag: '"abc"' }];
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => parts });
        vi.stubGlobal('fetch', fetchMock);
        const { default: uppyModal } = await import('./uppyModal.js');
        const opts = getAwsOpts(uppyModal(NODE_SAFE_OPTIONS) as unknown as FakeUppy);

        const result = await (opts.listParts as ListPartsFn)(
            { name: 'f.jpg' },
            { key: 'original/u1/f.jpg', uploadId: 'up1' },
            new AbortController().signal,
        );

        expect(result).toEqual(parts);
    });
});

// FIX 5: with uploadThumbnails:false (abe) the ThumbnailGenerator still renders
// dashboard previews, but the preview is NOT re-added as a separate S3 upload
// (capsule discards isThumbnail). Absent/true (edo) keeps uploading it.
describe('uppyModal — uploadThumbnails gates the S3 thumbnail upload (FIX 5)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const stubThumbnailIO = () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: async () => ({ type: 'image/png' }) }));
        vi.stubGlobal('File', class FakeFile {
            constructor(public parts: unknown[], public name: string, public opts: { type?: string } = {}) {}
        });
    };

    it('does NOT re-add the generated thumbnail when uploadThumbnails is false', async () => {
        stubThumbnailIO();
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, enableThumbnails: true, uploadThumbnails: false }) as unknown as FakeUppy;

        const handler = uppy.handlers['thumbnail:generated'];
        expect(handler).toBeDefined();
        await handler({ id: 'f1', name: 'a.jpg', meta: {} }, 'data:image/png;base64,xxx');

        expect(uppy.addFile).not.toHaveBeenCalled();
    });

    it('re-adds the generated thumbnail when uploadThumbnails is absent (edo default true)', async () => {
        stubThumbnailIO();
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, enableThumbnails: true }) as unknown as FakeUppy;

        const handler = uppy.handlers['thumbnail:generated'];
        await handler({ id: 'f2', name: 'b.jpg', meta: {} }, 'data:image/png;base64,xxx');

        expect(uppy.addFile).toHaveBeenCalledTimes(1);
        expect(uppy.addFile.mock.calls[0][0].meta.isThumbnail).toBe(true);
    });
});

// FIX 6: the 'complete' handler used to count EVERY non-thumbnail S3-successful
// file, announcing a failed ingest to the parent as success. It now counts only
// files whose server response is `ingested:true`, and reports the rest as `failed`.
describe('uppyModal — complete handler counts only ingested files (FIX 6)', () => {
    const ALLOWED = 'https://designer.abeduls.com';

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('excludes an ingested:false file from count, reports it as failed, and posts { count, failed }', async () => {
        const { postMessage } = installFakeBrowserGlobals('', ALLOWED);
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED] }) as unknown as FakeUppy;
        postMessage.mockClear(); // drop the uppy-ready call fired at mount

        const complete = uppy.handlers['complete'];
        expect(complete).toBeDefined();
        complete({
            successful: [
                { meta: {}, ingestResponse: { ingested: true, uploads: [{ id: 1, url: 'https://cdn/a.jpg' }] } },
                { meta: {}, ingestResponse: { ingested: false } },
                { meta: { isThumbnail: true }, ingestResponse: { ingested: false } },
            ],
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        const [payload, target] = postMessage.mock.calls[0];
        expect(target).toBe(ALLOWED);
        expect(payload).toEqual({
            type: 'upload-complete',
            count: 1,
            failed: 1,
            uploads: [{ id: 1, url: 'https://cdn/a.jpg' }],
        });
    });

    it('omits uploads and reports failed only when no file ingested', async () => {
        const { postMessage } = installFakeBrowserGlobals('', ALLOWED);
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED] }) as unknown as FakeUppy;
        postMessage.mockClear(); // drop the uppy-ready call fired at mount

        uppy.handlers['complete']({
            successful: [{ meta: {}, ingestResponse: { ingested: false, rejected: 'over-limit' } }],
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage.mock.calls[0][0]).toEqual({ type: 'upload-complete', count: 0, failed: 1 });
    });
});

// Regression: FIX 6 counted every non-ingested file as `failed`, which broke edo
// — edo has no ingest step, so completeMultipartUpload returns `ingested:false,
// ingestConfigured:false` for a genuine S3 success. The handler now treats
// `ingestConfigured:false` as an addition (count), reserving `failed` for the abe
// case where ingest was expected (ingestConfigured:true) but no row persisted.
describe('uppyModal — complete handler honors ingestConfigured (edo no-ingest regression)', () => {
    const ALLOWED = 'https://designer.abeduls.com';

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('counts an ingestConfigured:false file (edo S3 success) in count, not failed', async () => {
        const { postMessage } = installFakeBrowserGlobals('', ALLOWED);
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED] }) as unknown as FakeUppy;
        postMessage.mockClear(); // drop the uppy-ready call fired at mount

        uppy.handlers['complete']({
            successful: [
                { meta: {}, ingestResponse: { location: 'l1', ingested: false, ingestConfigured: false } },
                { meta: {}, ingestResponse: { location: 'l2', ingested: false, ingestConfigured: false } },
            ],
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage.mock.calls[0][0]).toEqual({ type: 'upload-complete', count: 2, failed: 0 });
    });

    it('counts an ingestConfigured:true + ingested:false file (abe ingest failure) in failed', async () => {
        const { postMessage } = installFakeBrowserGlobals('', ALLOWED);
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED] }) as unknown as FakeUppy;
        postMessage.mockClear(); // drop the uppy-ready call fired at mount

        uppy.handlers['complete']({
            successful: [{ meta: {}, ingestResponse: { location: 'l', ingested: false, ingestConfigured: true } }],
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage.mock.calls[0][0]).toEqual({ type: 'upload-complete', count: 0, failed: 1 });
    });

    it('mixes ingested:true, edo (ingestConfigured:false), and abe-failed files correctly', async () => {
        const { postMessage } = installFakeBrowserGlobals('', ALLOWED);
        const { default: uppyModal } = await import('./uppyModal.js');
        const uppy = uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED] }) as unknown as FakeUppy;
        postMessage.mockClear(); // drop the uppy-ready call fired at mount

        uppy.handlers['complete']({
            successful: [
                { meta: {}, ingestResponse: { ingested: true, uploads: [{ id: 1, url: 'https://cdn/a.jpg' }] } },
                { meta: {}, ingestResponse: { ingested: false, ingestConfigured: false } },
                { meta: {}, ingestResponse: { ingested: false, ingestConfigured: true } },
            ],
        });

        expect(postMessage.mock.calls[0][0]).toEqual({
            type: 'upload-complete',
            count: 2,
            failed: 1,
            uploads: [{ id: 1, url: 'https://cdn/a.jpg' }],
        });
    });
});

// The parent frame (capsule/designer modal) runs a short timeout after showing
// the iframe and falls back to its own in-app uploader if this message never
// arrives — the only way to detect a load failure a server-side health probe
// structurally cannot see (frame-ancestors CSP rejection, a network failure
// reaching this origin from the user's browser, etc.).
describe('uppyModal — announces readiness to the parent frame on mount', () => {
    const ALLOWED = 'https://designer.abeduls.com';

    it('posts { type: "uppy-ready" } to the allow-listed referrer origin once mounted', async () => {
        const { postMessage } = installFakeBrowserGlobals('', ALLOWED);
        const { default: uppyModal } = await import('./uppyModal.js');
        uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED] });

        expect(postMessage).toHaveBeenCalledWith({ type: 'uppy-ready' }, ALLOWED);
    });

    it('does not post uppy-ready when the referrer is not allow-listed', async () => {
        const { postMessage } = installFakeBrowserGlobals('', 'https://evil.example.com');
        const { default: uppyModal } = await import('./uppyModal.js');
        uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED] });

        expect(postMessage).not.toHaveBeenCalled();
    });

    it('does not post uppy-ready when there is no referrer at all', async () => {
        const { postMessage } = installFakeBrowserGlobals('');
        const { default: uppyModal } = await import('./uppyModal.js');
        uppyModal({ ...NODE_SAFE_OPTIONS, allowedAncestors: [ALLOWED] });

        expect(postMessage).not.toHaveBeenCalled();
    });

    it('is node-safe: does not throw when window/document are absent', async () => {
        const { default: uppyModal } = await import('./uppyModal.js');
        expect(() => uppyModal(NODE_SAFE_OPTIONS)).not.toThrow();
    });
});
