import { describe, it, expect, vi } from 'vitest';

/**
 * uppyModal.ts is a browser bundle (`@ts-nocheck`, imports the Uppy SDK from
 * a CDN URL specifier) transpiled standalone by scripts/build-assets.mjs — it
 * is excluded from coverage (vitest.config.ts) because most of it only runs
 * in a real DOM. The factory body itself (plugin registration, Dashboard
 * options, `restrictions`), though, has no DOM dependency as long as the
 * GOOGLE_* and enableThumbnails options are all supplied (see
 * NODE_SAFE_OPTIONS below) — mocking the CDN specifier lets it run under
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
    constructor(constructorOptions: Record<string, unknown> = {}) {
        this.constructorOptions = constructorOptions;
    }
    use(plugin: string, opts?: Record<string, unknown>): FakeUppy {
        this.plugins.push({ plugin, opts });
        return this;
    }
    on(_event: string, _handler: (...args: unknown[]) => void): FakeUppy {
        return this;
    }
    setMeta(_meta: Record<string, unknown>): FakeUppy {
        return this;
    }
}

vi.mock('https://releases.transloadit.com/uppy/v5.1.8/uppy.min.mjs', () => ({
    Uppy: FakeUppy,
    Dashboard: 'Dashboard',
    Facebook: 'Facebook',
    Dropbox: 'Dropbox',
    GoogleDrive: 'GoogleDrive',
    Instagram: 'Instagram',
    OneDrive: 'OneDrive',
    Box: 'Box',
    Unsplash: 'Unsplash',
    Zoom: 'Zoom',
    Url: 'Url',
    GoogleDrivePicker: 'GoogleDrivePicker',
    GooglePhotosPicker: 'GooglePhotosPicker',
    ThumbnailGenerator: 'ThumbnailGenerator',
    Compressor: 'Compressor',
    ImageEditor: 'ImageEditor',
    AwsS3: 'AwsS3',
}));

const NODE_SAFE_OPTIONS = {
    plugins: [],
    enableThumbnails: false,
    GOOGLE_API_KEY_DRIVE: '',
    GOOGLE_API_KEY_PHOTOS: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_APP_ID: '',
};

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
