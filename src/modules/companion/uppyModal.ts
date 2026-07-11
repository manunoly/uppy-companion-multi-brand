// @ts-nocheck
/// <reference lib="dom" />
// @ts-ignore
import {
    Uppy,
    Dashboard,
    // Companion Providers
    Facebook,
    Dropbox,
    GoogleDrive,
    Instagram,
    OneDrive,
    Box,
    Unsplash,
    Zoom,
    Url,
    // Google Pickers
    GoogleDrivePicker,
    GooglePhotosPicker,
    // Plugins
    ThumbnailGenerator,
    Compressor,
    ImageEditor,
    AwsS3,
} from 'https://releases.transloadit.com/uppy/v5.1.8/uppy.min.mjs';


// --- Types & Interfaces ---

interface HelperOptions {
    [key: string]: any;
}

export interface UppyModalOptions {
    trigger?: string;
    inline?: boolean;
    plugins?: string[];
    SERVER_URL?: string;
    COMPANION_URL?: string;
    COMPANION_ALLOWED_HOSTS?: RegExp;
    allowedAncestors?: string[];
    GOOGLE_API_KEY_DRIVE?: string | null;
    GOOGLE_API_KEY_PHOTOS?: string | null;
    GOOGLE_CLIENT_ID?: string | null;
    GOOGLE_APP_ID?: string | null;
    callbackFn?: (result: any) => void;
    brand?: string;
    brandName?: string | null;
    brandLogoUrl?: string | null;
    brandUserEndpoint?: string | null;
    enableThumbnails?: boolean;
    [key: string]: any;
}

// --- Constants ---

const DEFAULT_PLUGINS = [
    'Facebook', 'Dropbox', 'GoogleDrive', 'Url',
    'Instagram', 'OneDrive', 'Box', 'Unsplash', 'Zoom',
    'GoogleDrivePicker', 'GooglePhotosPicker'
];

// --- Helpers ---

const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 999);

const serialize = (data: Record<string, any>): URLSearchParams => {
    const params = new URLSearchParams();
    Object.entries(data || {}).forEach(([key, value]) => {
        if (value == null) return;
        if (Array.isArray(value)) {
            value.forEach((item) => params.append(`${key}[]`, item));
        } else {
            params.append(key, String(value));
        }
    });
    return params;
};

const readOption = (options: HelperOptions, key: string, fallback: any): any => {
    if (options[key] != null) return options[key];
    const element = document.getElementById(key) as HTMLInputElement;
    return element ? element.value : fallback;
};

// Multipart for EVERY file — deliberate deviation from Uppy's default (single
// PUT under 100 MiB, multipart above). completeMultipartUpload is the only
// universal server completion hook (single PUT has none), and the Phase-1 wire
// contract needs it for HeadObject size enforcement + inline ingest on EVERY
// upload, tiny images included.
const shouldUseMultipart = () => true;

// --- Main Function ---

const uppyModal = (options: UppyModalOptions = {}) => {
    const merged: UppyModalOptions = {
        trigger: '#uppyModalOpener',
        inline: false,
        plugins: DEFAULT_PLUGINS,
        SERVER_URL: 'http://localhost:3000',
        COMPANION_URL: 'http://localhost:3020',
        COMPANION_ALLOWED_HOSTS: /.*/,
        allowedAncestors: [],
        GOOGLE_API_KEY_DRIVE: null,
        GOOGLE_API_KEY_PHOTOS: null,
        GOOGLE_CLIENT_ID: null,
        GOOGLE_APP_ID: null,
        callbackFn: undefined,
        brand: 'default',
        brandName: null,
        brandLogoUrl: null,
        brandUserEndpoint: null,
        enableThumbnails: true,
        ...options,
    };

    const SERVER_URL = readOption(merged, 'SERVER_URL', 'http://localhost:3000');
    const COMPANION_URL = readOption(merged, 'COMPANION_URL', 'http://localhost:3020');
    const COMPANION_ALLOWED_HOSTS = merged.COMPANION_ALLOWED_HOSTS ?? /.*/;
    const ALLOWED_ANCESTORS = Array.isArray(merged.allowedAncestors) ? merged.allowedAncestors : [];

    const GOOGLE_API_KEY_DRIVE = readOption(merged, 'GOOGLE_API_KEY_DRIVE', null);
    const GOOGLE_API_KEY_PHOTOS = readOption(merged, 'GOOGLE_API_KEY_PHOTOS', null);
    const GOOGLE_CLIENT_ID = readOption(merged, 'GOOGLE_CLIENT_ID', null);
    const GOOGLE_APP_ID = readOption(merged, 'GOOGLE_APP_ID', null);
    // Auth travels via the brand session cookie at Domain=.<rootDomain>.
    // The browser sends it automatically with credentials: 'include' on the
    // same-origin /api/uppy/* calls that sign/create/complete the S3 upload.
    const fetchWithAuth = (url: string, options: RequestInit = {}) =>
        fetch(url, { ...options, credentials: 'include' });

    // Browser mirror of origin-guard.ts#resolveAllowedTargetOrigin — the asset
    // build uses esbuild `transform` (not `bundle`), so this file cannot import
    // it. Returns the validated parent origin, or null to abort (never '*').
    const resolveAllowedTargetOrigin = (referrer: string, allowed: string[]): string | null => {
        if (!referrer) return null;
        try {
            const origin = new URL(referrer).origin;
            return allowed.includes(origin) ? origin : null;
        } catch {
            return null;
        }
    };

    const uppy = new Uppy({
        debug: true,
        autoProceed: false,
        // Mirrors designer's UppyDashboardAws restrictions, reconciled with abe's
        // server-side brand limits (registry): 50 MiB cap and image-only types so
        // client validation matches what /api/uppy/sign-s3 will accept.
        restrictions: {
            maxFileSize: 50 * 1024 * 1024,
            maxNumberOfFiles: 50,
            minNumberOfFiles: 1,
            allowedFileTypes: ['image/*', '.heic', '.HEIC', '.heif', '.HEIF'],
        },
        onBeforeFileAdded: (file: any) => {
            if (file.meta.isThumbnail) {
                file.name = sanitizeName(file.name);
                return file;
            }
            file.name = sanitizeName(file.name);
            return file;
        },
    });

    const initialMeta: Record<string, any> = {};
    if (merged.brand) initialMeta.brand = merged.brand;
    if (merged.brandName) initialMeta.brandName = merged.brandName;
    if (merged.brandLogoUrl) initialMeta.brandLogoUrl = merged.brandLogoUrl;
    if (merged.brandUserEndpoint) initialMeta.brandUserEndpoint = merged.brandUserEndpoint;

    if (Object.keys(initialMeta).length > 0) {
        uppy.setMeta(initialMeta);
    }

    if (merged.brandName) {
        document.body.dataset.brandName = merged.brandName;
    }
    if (merged.brandLogoUrl) {
        document.body.dataset.brandLogoUrl = merged.brandLogoUrl;
    }

    uppy.use(Dashboard, {
        trigger: merged.trigger,
        inline: merged.inline,
        proudlyDisplayPoweredByUppy: false,
        height: 470,
        width: '100%',
        hideUploadButton: false,
        hideRetryButton: false,
        hidePauseResumeButton: false,
        hideCancelButton: false,
        showRemoveButtonAfterComplete: true,
        plugins: ['ImageEditor', ...(merged.plugins ?? [])],
    });

    // Visual parity with designer's UppyDashboardAws: pre-upload compression +
    // in-Dashboard crop/rotate editor. ImageEditor targets the Dashboard, so it
    // must be registered after it.
    uppy.use(Compressor);
    uppy.use(ImageEditor, { target: Dashboard });

    // --- Companion Plugins ---
    if (merged.plugins?.includes('Facebook')) {
        uppy.use(Facebook, { target: Dashboard, companionUrl: COMPANION_URL });
    }
    if (merged.plugins?.includes('Dropbox')) {
        uppy.use(Dropbox, { target: Dashboard, companionUrl: COMPANION_URL, companionAllowedHosts: COMPANION_ALLOWED_HOSTS });
    }
    if (merged.plugins?.includes('GoogleDrive')) {
        uppy.use(GoogleDrive, { target: Dashboard, companionUrl: COMPANION_URL, companionAllowedHosts: COMPANION_ALLOWED_HOSTS });
    }
    if (merged.plugins?.includes('Url')) {
        uppy.use(Url, { target: Dashboard, companionUrl: COMPANION_URL });
    }
    if (merged.plugins?.includes('Instagram')) {
        uppy.use(Instagram, { target: Dashboard, companionUrl: COMPANION_URL });
    }
    if (merged.plugins?.includes('OneDrive')) {
        uppy.use(OneDrive, { target: Dashboard, companionUrl: COMPANION_URL });
    }
    if (merged.plugins?.includes('Box')) {
        uppy.use(Box, { target: Dashboard, companionUrl: COMPANION_URL });
    }
    if (merged.plugins?.includes('Unsplash')) {
        uppy.use(Unsplash, { target: Dashboard, companionUrl: COMPANION_URL });
    }
    if (merged.plugins?.includes('Zoom')) {
        uppy.use(Zoom, { target: Dashboard, companionUrl: COMPANION_URL });
    }

    // --- Google Pickers ---
    if (merged.plugins?.includes('GoogleDrivePicker')) {
        uppy.use(GoogleDrivePicker, {
            target: Dashboard,
            clientId: GOOGLE_CLIENT_ID,
            apiKey: GOOGLE_API_KEY_DRIVE,
            appId: GOOGLE_APP_ID,
            companionUrl: COMPANION_URL,
        });
    }
    if (merged.plugins?.includes('GooglePhotosPicker')) {
        uppy.use(GooglePhotosPicker, {
            target: Dashboard,
            clientId: GOOGLE_CLIENT_ID,
            apiKey: GOOGLE_API_KEY_PHOTOS,
            companionUrl: COMPANION_URL,
        });
    }

    if (merged.enableThumbnails !== false) {
        // --- Thumbnail Generator ---
        uppy.use(ThumbnailGenerator, {
            thumbnailWidth: 200,
            waitForThumbnailsBeforeUpload: false,
        });

        const generatedThumbnailFor = new Set<string>();

        uppy.on('thumbnail:generated', async (file: any, preview: string) => {
            if (file.meta.isThumbnail) return;
            if (generatedThumbnailFor.has(file.id)) return;
            generatedThumbnailFor.add(file.id);

            try {
                const response = await fetch(preview);
                const blob = await response.blob();

                const thumbnailFile = new File([blob], `thumb_${file.name}`, {
                    type: blob.type
                });

                uppy.addFile({
                    name: thumbnailFile.name,
                    type: thumbnailFile.type,
                    data: thumbnailFile,
                    meta: {
                        ...file.meta,
                        isThumbnail: true,
                        originalFileId: file.id,
                        originalFileName: file.name,
                    },
                });
            } catch (err) {
                console.error('Error creating thumbnail file:', err);
            }
        });
    }

    // --- AWS S3 ---

    uppy.use(AwsS3, {
        getTemporarySecurityCredentials: false,
        shouldUseMultipart,

        async getUploadParameters(file: any, options: { signal: AbortSignal }) {
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/sign-s3`, {
                method: 'POST',
                body: serialize({
                    filename: sanitizeName(file.name),
                    contentType: file.type,
                }) as any, // Cast to any because fetch body types are strict
                signal: options.signal,
            });

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response });

            const data = await response.json();

            if ((!file.uploadURL || file.uploadURL === 'undefined' || file.uploadURL === 'null') && data.url) {
                file.uploadAwsUrl = decodeURIComponent(data.url.split('?')[0]);
            } else if (file.uploadURL && file.uploadURL !== 'undefined' && file.uploadURL !== 'null') {
                file.uploadAwsUrl = decodeURIComponent(file.uploadURL.split('?')[0]);
            }

            return {
                method: data.method,
                url: data.url,
                fields: {},
                headers: {
                    'Content-Type': file.type,
                },
            };
        },

        async createMultipartUpload(file: any, signal: AbortSignal) {
            if (signal?.aborted) {
                const err = new DOMException('The operation was aborted', 'AbortError');
                Object.defineProperty(err, 'cause', { configurable: true, writable: true, value: signal.reason });
                throw err;
            }

            // Every value travels as a clean top-level field: filename/type/
            // declared size + optional folder/thumbnail flag. No `metadata`
            // object — serialize() stringifies it to the literal "[object
            // Object]", which the server can't build an S3 key from.
            const createBody: Record<string, any> = {
                filename: sanitizeName(file.name),
                type: file.type,
                size: file.size,
            };
            if (file.meta?.folderId != null && file.meta.folderId !== '') {
                createBody.folderId = file.meta.folderId;
            }
            if (file.meta?.isThumbnail) {
                createBody.isThumbnail = 'true';
            }

            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart`, {
                method: 'POST',
                body: serialize(createBody) as any,
                signal,
            });

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response });

            return response.json();
        },

        async abortMultipartUpload(file: any, { key, uploadId }: any, signal: AbortSignal) {
            const filename = encodeURIComponent(key);
            const uploadIdEnc = encodeURIComponent(uploadId);
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart/${uploadIdEnc}?key=${filename}`, {
                method: 'DELETE',
                signal,
            });

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response });
        },

        async signPart(file: any, options: any) {
            const { uploadId, key, partNumber, signal } = options;

            if (signal?.aborted) {
                const err = new DOMException('The operation was aborted', 'AbortError');
                Object.defineProperty(err, 'cause', { configurable: true, writable: true, value: signal.reason });
                throw err;
            }

            if (uploadId == null || key == null || partNumber == null) {
                throw new Error('Cannot sign without a key, an uploadId, and a partNumber');
            }

            const filename = encodeURIComponent(key);
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart/${uploadId}/${partNumber}?key=${filename}`, {
                signal,
            });

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response });

            return response.json();
        },

        async listParts(file: any, { key, uploadId }: any, signal: AbortSignal) {
            if (signal?.aborted) {
                const err = new DOMException('The operation was aborted', 'AbortError');
                Object.defineProperty(err, 'cause', { configurable: true, writable: true, value: signal.reason });
                throw err;
            }

            const filename = encodeURIComponent(key);
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart/${uploadId}?key=${filename}`, {
                signal,
            });

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response });

            const data = await response.json();
            return data && data.parts ? data.parts : [];
        },

        async completeMultipartUpload(file: any, { key, uploadId, parts }: any, signal: AbortSignal) {
            if (signal?.aborted) {
                const err = new DOMException('The operation was aborted', 'AbortError');
                Object.defineProperty(err, 'cause', { configurable: true, writable: true, value: signal.reason });
                throw err;
            }

            const filename = encodeURIComponent(key);
            const uploadIdEnc = encodeURIComponent(uploadId);
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart/${uploadIdEnc}/complete?key=${filename}`, {
                method: 'POST',
                body: serialize({ parts }) as any,
                signal,
            });

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response });

            const data = await response.json();
            // Retain the server's { location, ingested, uploads? } so the
            // 'complete' handler can forward the ingested library entries to the
            // parent frame — Uppy only surfaces `location` on the file itself.
            file.ingestResponse = data;
            return data;
        },
    });

    // Server-side ingest (completeMultipartUpload -> capsule) is the ONLY
    // phase-1 library notification — the legacy client-side saveFileToDB POST
    // is gone. On 'complete', notify the parent frame so the designer can
    // refresh its library, guarding the postMessage target against the injected
    // allow-list (never '*', never a foreign origin).
    uppy.on('complete', (result: any) => {
        if (merged.callbackFn) merged.callbackFn(result);

        const successful = Array.isArray(result?.successful) ? result.successful : [];
        const uploads: any[] = [];
        let count = 0;
        for (const file of successful) {
            if (file.meta?.isThumbnail) continue; // thumbnails are not library assets
            count += 1;
            const ingested = file.ingestResponse;
            if (ingested?.uploads?.length) uploads.push(...ingested.uploads);
        }

        const targetOrigin = resolveAllowedTargetOrigin(document.referrer, ALLOWED_ANCESTORS);
        if (!targetOrigin) return;

        const payload: Record<string, any> = { type: 'upload-complete', count };
        if (uploads.length > 0) payload.uploads = uploads;
        window.parent.postMessage(payload, targetOrigin);
    });

    return uppy;
};

export default uppyModal;
