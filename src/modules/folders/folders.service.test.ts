import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFolders } from './folders.service.js';
import { makeBrand } from '../../test-utils/fixtures.js';

describe('fetchFolders', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('returns [] when foldersUrl is not configured', async () => {
        const brand = makeBrand({ public: { foldersUrl: undefined } });
        const folders = await fetchFolders('tok', brand);
        expect(folders).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns [] when public block is absent entirely', async () => {
        const brand = makeBrand({ public: undefined });
        const folders = await fetchFolders('tok', brand);
        expect(folders).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns json.data when backend returns success:true with array', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: [{ id: '1', name: 'F1' }] }),
        });
        const folders = await fetchFolders('tok', makeBrand());
        expect(folders).toEqual([{ id: '1', name: 'F1' }]);
    });

    it('returns [] when success is false', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: false, data: [] }),
        });
        const folders = await fetchFolders('tok', makeBrand());
        expect(folders).toEqual([]);
    });

    it('returns [] when data is not an array', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: { not: 'array' } }),
        });
        const folders = await fetchFolders('tok', makeBrand());
        expect(folders).toEqual([]);
    });

    it('returns [] on non-ok response', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 401 });
        const folders = await fetchFolders('tok', makeBrand());
        expect(folders).toEqual([]);
    });

    it('returns [] when fetch throws', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ETIMEDOUT'));
        const folders = await fetchFolders('tok', makeBrand());
        expect(folders).toEqual([]);
    });

    it('forwards cookie token to backend under the brand session cookie name (not Authorization)', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: [] }),
        });
        await fetchFolders('cookietok', makeBrand());
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[1]?.headers?.Cookie).toBe('session=cookietok');
    });

    it('fetches the configured absolute foldersUrl as-is', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: [] }),
        });
        await fetchFolders('t', makeBrand({
            public: { foldersUrl: 'https://x.example.com/api/folders' },
        }));
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0]).toBe('https://x.example.com/api/folders');
    });
});
