import { describe, it, expect, vi } from 'vitest';

/**
 * uppyModal.ts is a browser bundle (`@ts-nocheck`, imports the Uppy SDK from
 * a CDN URL specifier) transpiled standalone by scripts/build-assets.mjs — it
 * is excluded from coverage (vitest.config.ts) because most of it only runs
 * in a real DOM. `shouldUseMultipart`, though, is a plain top-level function
 * with no DOM dependency, registered as-is on the AwsS3 plugin: mocking the
 * CDN specifier lets it run for real under Vitest and pins the P1-C-PROTOCOL
 * deviation from Uppy's default (single PUT under 100 MiB, multipart above)
 * — EVERY file goes through multipart now, tiny images included, because
 * completeMultipartUpload is the only universal server completion hook.
 */

interface FakePluginRegistration {
    plugin: string;
    opts?: Record<string, unknown>;
}

class FakeUppy {
    plugins: FakePluginRegistration[] = [];
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
    AwsS3: 'AwsS3',
}));

describe('uppyModal — shouldUseMultipart (P1-C-PROTOCOL multipart-for-all deviation)', () => {
    it('registers AwsS3 with a shouldUseMultipart that returns true regardless of file size', async () => {
        const { default: uppyModal } = await import('./uppyModal.js');

        // GOOGLE_* options must be non-null so uppyModal's readOption() never
        // falls through to `document.getElementById` — this suite runs in
        // Vitest's node environment (no DOM).
        const uppy = uppyModal({
            plugins: [],
            enableThumbnails: false,
            GOOGLE_API_KEY_DRIVE: '',
            GOOGLE_API_KEY_PHOTOS: '',
            GOOGLE_CLIENT_ID: '',
            GOOGLE_APP_ID: '',
        }) as unknown as FakeUppy;

        const awsS3Registration = uppy.plugins.find((registration) => registration.plugin === 'AwsS3');
        expect(awsS3Registration).toBeDefined();

        const shouldUseMultipart = awsS3Registration?.opts?.shouldUseMultipart as (file: { size: number }) => boolean;
        expect(typeof shouldUseMultipart).toBe('function');
        expect(shouldUseMultipart({ size: 1024 })).toBe(true); // tiny file
        expect(shouldUseMultipart({ size: 6 * 1024 ** 3 })).toBe(true); // well above Uppy's 100 MiB default — still true
    });
});
