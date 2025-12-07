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
    PUBLIC_BACKEND_URL?: string;
    GOOGLE_API_KEY?: string | null;
    GOOGLE_DRIVE_CLIENT_ID?: string | null;
    bearerToken?: string | null;
    callbackFn?: (result: any) => void;
    brand?: string;
    brandName?: string | null;
    brandLogoUrl?: string | null;
    brandUserEndpoint?: string | null;
    [key: string]: any;
}

// --- Constants ---

const DEFAULT_PLUGINS = [
    'Facebook', 'Dropbox', 'GoogleDrive', 'Url',
    'Instagram', 'OneDrive', 'Box', 'Unsplash', 'Zoom',
    'GoogleDrivePicker', 'GooglePhotosPicker'
];

const FOLDERS = ['home', 'share', 'my-folder'];

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

const createFolderSelect = (uppy: any) => {
    if (document.getElementById('uppyStaticFolder')) return;
    const container = document.querySelector('.uppy-Dashboard-innerWrap');
    if (!container) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'uppy-DashboardTab';
    wrapper.style.cssText = 'padding:10px;display:flex;justify-content:center;';

    const select = document.createElement('select');
    select.id = 'uppyStaticFolder';
    select.style.cssText = 'width:200px;border-radius:8px;padding:6px;';

    FOLDERS.forEach((folder) => {
        const option = document.createElement('option');
        option.value = folder;
        option.textContent = folder;
        select.appendChild(option);
    });

    const setFolder = (value: string) => uppy.setMeta({ folder: value });
    select.addEventListener('change', () => setFolder(select.value));
    setFolder(select.value);

    wrapper.appendChild(select);
    container.insertBefore(wrapper, container.firstChild);
};

const shouldUseMultipart = (file: any) => file.size > 100 * 1024 * 1024;

// --- Main Function ---

const uppyModal = (options: UppyModalOptions = {}) => {
    const merged: UppyModalOptions = {
        trigger: '#uppyModalOpener',
        inline: false,
        plugins: DEFAULT_PLUGINS,
        SERVER_URL: 'http://localhost:3000',
        COMPANION_URL: 'http://localhost:3020',
        COMPANION_ALLOWED_HOSTS: /.*/,
        PUBLIC_BACKEND_URL: 'http://localhost',
        GOOGLE_API_KEY: null,
        GOOGLE_DRIVE_CLIENT_ID: null,
        callbackFn: undefined,
        brand: 'default',
        brandName: null,
        brandLogoUrl: null,
        brandUserEndpoint: null,
        ...options,
    };

    const SERVER_URL = readOption(merged, 'SERVER_URL', 'http://localhost:3000');
    const COMPANION_URL = readOption(merged, 'COMPANION_URL', 'http://localhost:3020');
    const COMPANION_ALLOWED_HOSTS = merged.COMPANION_ALLOWED_HOSTS ?? /.*/;
    const PUBLIC_BACKEND_URL = readOption(merged, 'PUBLIC_BACKEND_URL', readOption(merged, 'PUBLIC_BACKEND_URL', 'http://localhost'));

    const GOOGLE_API_KEY = readOption(merged, 'GOOGLE_API_KEY', null);
    const GOOGLE_DRIVE_CLIENT_ID = readOption(merged, 'GOOGLE_DRIVE_CLIENT_ID', null);
    const BEARER_TOKEN = readOption(merged, 'bearerToken', null);

    const authHeaders = BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {};
    const mergeHeaders = (headers: Record<string, string> = {}) => ({ ...headers, ...authHeaders });

    const fetchWithAuth = (url: string, options: RequestInit = {}) => {
        const headers = mergeHeaders(options.headers as Record<string, string>);
        return fetch(url, { ...options, headers });
    };

    const uppy = new Uppy({
        debug: true,
        autoProceed: false,
        restrictions: {
            maxFileSize: 4 * 1024 * 1024 * 1024,
            maxNumberOfFiles: 600,
            minNumberOfFiles: 1,
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
        hideCancelButton: true,
        hidePauseResumeCancelButtons: true,
        hidePauseResumeButton: true,
        plugins: merged.plugins,
    });

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
            clientId: GOOGLE_DRIVE_CLIENT_ID,
            apiKey: GOOGLE_API_KEY,
            companionUrl: COMPANION_URL,
        });
    }
    if (merged.plugins?.includes('GooglePhotosPicker')) {
        uppy.use(GooglePhotosPicker, {
            target: Dashboard,
            clientId: GOOGLE_DRIVE_CLIENT_ID,
            apiKey: GOOGLE_API_KEY,
            companionUrl: COMPANION_URL,
        });
    }

    // --- Thumbnail Generator ---
    uppy.use(ThumbnailGenerator, {
        thumbnailWidth: 200,
        waitForThumbnailsBeforeUpload: false,
    });

    uppy.on('thumbnail:generated', async (file: any, preview: string) => {
        if (file.meta.isThumbnail) return;

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
                    originalFileName: file.name,
                },
            });
        } catch (err) {
            console.error('Error creating thumbnail file:', err);
        }
    });

    // --- AWS S3 ---
    const ensureFolderSelect = () => createFolderSelect(uppy);
    uppy.on('dashboard:modal-open', ensureFolderSelect);
    uppy.on('dashboard:mount', ensureFolderSelect);
    setTimeout(ensureFolderSelect, 0);

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

            const metadata: Record<string, string> = {};
            Object.keys(file.meta || {}).forEach((key) => {
                if (file.meta[key] != null) {
                    metadata[key] = file.meta[key].toString().replace(/[^a-zA-Z0-9.]/g, '');
                }
            });

            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart`, {
                method: 'POST',
                body: serialize({
                    filename: sanitizeName(file.name),
                    type: file.type,
                    metadata,
                }) as any,
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

            return response.json();
        },
    });

    const saveFileToDB = async (imagesData: any) => {
        if (!imagesData || imagesData.length === 0) throw new Error('imagesData is empty');
        try {
            const currentFolder = uppy.getState().meta?.folder || '';
            const response = await fetchWithAuth(`${PUBLIC_BACKEND_URL}/api/frame/contents/upload/public`, {
                method: 'POST',
                body: serialize({ images: imagesData, folder: currentFolder }) as any,
            });
            if (!response.ok) {
                console.warn('saveFileToDB', response);
            }
        } catch (error) {
            console.warn('saveFileToDB ERROR', error);
            // alert('There was an unexpected error saving the images. Please contact support.');
        }
    };

    uppy.on('upload-success', (file: any, response: any) => {
        if ((!file.uploadAwsUrl || file.uploadAwsUrl === 'undefined' || file.uploadAwsUrl === 'null') && response.uploadURL) {
            file.uploadAwsUrl = decodeURIComponent(response.uploadURL.split('?')[0]);
        } else if (file.uploadURL && file.uploadURL !== 'undefined' && file.uploadURL !== 'null') {
            file.uploadAwsUrl = decodeURIComponent(file.uploadURL.split('?')[0]);
        }

        if (!file.response) file.response = response;

        // IMPORTANT: Only save original files to DB, not thumbnails
        if (file.meta.isThumbnail) {
            console.log('Thumbnail uploaded:', file.name);
            return;
        }

        const imagesData = JSON.stringify([file]);
        saveFileToDB(imagesData);
    });

    uppy.on('complete', (result: any) => {
        if (merged.callbackFn) merged.callbackFn(result);
    });

    return uppy;
};

export default uppyModal;
