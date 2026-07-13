import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import {
    toJsStringLiteral,
    safeJsonForHtmlScript,
    safePath,
    getEnabledPlugins,
    serveUppyPage,
    serveUppyModalJs,
    serveUppyCss,
    assetCacheControl,
} from './uppy.routes.js';
import { getBaseBrandConfig } from '../brand/registry.js';
import { makeBrand, makeAppRequest, makeUser } from '../../test-utils/fixtures.js';
import type { AppRequest } from '../../core/types/express.js';

describe('toJsStringLiteral', () => {
    it('wraps plain text in single quotes', () => {
        expect(toJsStringLiteral('hello')).toBe("'hello'");
    });

    it('returns "" for null/undefined', () => {
        expect(toJsStringLiteral(null)).toBe("''");
        expect(toJsStringLiteral(undefined)).toBe("''");
    });

    it('escapes backslash before quote (order matters)', () => {
        expect(toJsStringLiteral('a\\b')).toBe("'a\\\\b'");
    });

    it('escapes single quote', () => {
        expect(toJsStringLiteral("a'b")).toBe("'a\\'b'");
    });

    it('escapes newline and carriage return', () => {
        expect(toJsStringLiteral('a\nb\rc')).toBe("'a\\nb\\rc'");
    });

    it('escapes < as \\u003C and > as \\u003E', () => {
        expect(toJsStringLiteral('<x>')).toBe("'\\u003Cx\\u003E'");
    });

    it('escapes U+2028 and U+2029', () => {
        const ls = String.fromCharCode(0x2028);
        const ps = String.fromCharCode(0x2029);
        expect(toJsStringLiteral(`a${ls}b${ps}c`)).toBe("'a\\u2028b\\u2029c'");
    });

    it('blocks </script> closure inside a string literal', () => {
        const out = toJsStringLiteral('</script><script>alert(1)</script>');
        expect(out.includes('</script>')).toBe(false);
        expect(out.includes('\\u003C/script\\u003E')).toBe(true);
    });
});

describe('safeJsonForHtmlScript', () => {
    it('produces JSON-valid output that round-trips via JSON.parse', () => {
        const input = { a: 'hello', b: 42, c: ['x', 'y'] };
        const out = safeJsonForHtmlScript(input);
        expect(JSON.parse(out)).toEqual(input);
    });

    it('escapes < and > so </script> cannot escape the script block', () => {
        const out = safeJsonForHtmlScript({ x: '</script><script>alert(1)</script>' });
        expect(out.includes('</script>')).toBe(false);
        expect(out.includes('\\u003C/script\\u003E')).toBe(true);
    });

    it('output remains valid JSON after escaping', () => {
        const out = safeJsonForHtmlScript({ x: '<!--' });
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it('escapes U+2028 and U+2029 (JS line terminators)', () => {
        const ls = String.fromCharCode(0x2028);
        const out = safeJsonForHtmlScript({ x: ls });
        expect(out).toContain('\\u2028');
    });

    it('handles arrays', () => {
        expect(safeJsonForHtmlScript([1, 2, 3])).toBe('[1,2,3]');
    });

    it('handles empty object', () => {
        expect(safeJsonForHtmlScript({})).toBe('{}');
    });
});

describe('safePath', () => {
    it('returns the path unchanged when it starts with a single slash', () => {
        expect(safePath('/foo/bar')).toBe('/foo/bar');
    });

    it('preserves query string', () => {
        expect(safePath('/foo?a=1')).toBe('/foo?a=1');
    });

    it('falls back to "/" for protocol-relative URLs', () => {
        expect(safePath('//evil.com/path')).toBe('/');
    });

    it('falls back to "/" for absolute http URL', () => {
        expect(safePath('http://evil.com/x')).toBe('/');
    });

    it('falls back to "/" for absolute https URL', () => {
        expect(safePath('https://evil.com/x')).toBe('/');
    });

    it('falls back to "/" for javascript: scheme', () => {
        expect(safePath('javascript:alert(1)')).toBe('/');
    });

    it('falls back to "/" for empty string', () => {
        expect(safePath('')).toBe('/');
    });

    it('falls back to "/" for path that does not start with /', () => {
        expect(safePath('foo')).toBe('/');
    });
});

// Hallazgo BAJO-3: getEnabledPlugins must only ever emit plugin names from the
// typed EdoUploadPlugin allowlist. companion.factory.ts's PLUGIN_PROVIDER_KEY
// only wires OAuth for Facebook/Dropbox/GoogleDrivePicker/GooglePhotosPicker/
// Url — emitting an out-of-allowlist name (Instagram/OneDrive/Box/Unsplash/
// Zoom) would render a Dashboard tab in uppyModal.ts with no working backend
// behind it, breaking the client.
describe('getEnabledPlugins (BAJO-3: typed EdoUploadPlugin allowlist)', () => {
    it('returns brand.upload.plugins verbatim when non-empty', () => {
        const brand = makeBrand({ upload: { plugins: ['Facebook', 'Url'], system: 'x', systemDetails: 'y' } });
        expect(getEnabledPlugins(brand)).toEqual(['Facebook', 'Url']);
    });

    it('never derives an out-of-allowlist plugin, even when legacy providers are configured', () => {
        const brand = makeBrand({
            upload: { plugins: [], system: 'x', systemDetails: 'y' },
            providers: {
                facebook: { key: 'k', secret: 's' },
                dropbox: { key: 'k', secret: 's' },
                google: { clientId: 'c' },
                instagram: { key: 'k', secret: 's' },
                onedrive: { key: 'k', secret: 's' },
                box: { key: 'k', secret: 's' },
                unsplash: { key: 'k', secret: 's' },
                zoom: { key: 'k', secret: 's' },
            },
        });
        const plugins = getEnabledPlugins(brand);
        expect(plugins).toEqual(expect.arrayContaining(['Url', 'Facebook', 'Dropbox', 'GoogleDrivePicker', 'GooglePhotosPicker']));
        for (const forbidden of ['Instagram', 'OneDrive', 'Box', 'Unsplash', 'Zoom']) {
            expect(plugins).not.toContain(forbidden);
        }
    });

    // FIX 3: an empty plugins list AND no providers means local-only (abe). Returning
    // ['Url'] would enable the remote-import surface, which bypasses the custom
    // completeMultipartUpload (no ingest) — out of Phase-1 scope.
    it('returns [] when upload.plugins is empty and no providers are configured (no remote Url surface)', () => {
        const brand = makeBrand({ upload: { plugins: [], system: 'x', systemDetails: 'y' }, providers: {} });
        expect(getEnabledPlugins(brand)).toEqual([]);
    });

    it('the real abe registry entry (empty plugins, no providers) resolves to []', () => {
        const abe = getBaseBrandConfig('abe');
        expect(getEnabledPlugins(abe)).toEqual([]);
    });
});

// Security review: `brand.auth.whoamiUrl` is re-validated against its own
// `whoamiAllowedHosts` allowlist right at the point it gets embedded into
// client HTML — defense-in-depth on top of the server-side-only validation
// `resolveSession` (session-resolver.ts) already performs before a caller
// can ever reach this branch (it requires `req.user` to already be set).
describe('serveUppyPage — whoamiUrl re-validated at the HTML-injection point', () => {
    const makeRes = () => {
        const state = { statusCode: 200, headers: {} as Record<string, string>, body: '' };
        const res = {
            locals: { cspNonce: 'test-nonce' },
            set(name: string, value: string) {
                state.headers[name] = value;
                return res;
            },
            setHeader(name: string, value: string) {
                state.headers[name] = value;
                return res;
            },
            status(code: number) {
                state.statusCode = code;
                return res;
            },
            send(body: string) {
                state.body = body;
                return res;
            },
        };
        return { res: res as unknown as Response, state };
    };

    it('omits whoamiUrl from the rendered page when it fails allowlist re-validation', async () => {
        const brand = makeBrand({
            auth: { whoamiUrl: 'https://evil.example.com/me', whoamiAllowedHosts: ['test.example.com'] },
            public: {},
        });
        const req = makeAppRequest({ brand, user: makeUser() });
        const { res, state } = makeRes();

        await serveUppyPage(req, res, vi.fn());

        expect(state.body.toLowerCase()).toContain('<!doctype html>');
        expect(state.body).not.toContain('evil.example.com');
    });

    it('still injects a whoamiUrl that passes allowlist re-validation', async () => {
        const brand = makeBrand({
            auth: { whoamiUrl: 'https://api.test.example.com/auth/me', whoamiAllowedHosts: ['test.example.com'] },
            public: {},
        });
        const req = makeAppRequest({ brand, user: makeUser() });
        const { res, state } = makeRes();

        await serveUppyPage(req, res, vi.fn());

        expect(state.body).toContain('https://api.test.example.com/auth/me');
    });
});

describe('serveUppyPage - self-hosted client assets', () => {
    const makeRes = () => {
        const state = { statusCode: 200, headers: {} as Record<string, string>, body: '' };
        const res = {
            locals: { cspNonce: 'test-nonce' },
            set(name: string, value: string) { state.headers[name] = value; return res; },
            setHeader(name: string, value: string) { state.headers[name] = value; return res; },
            status(code: number) { state.statusCode = code; return res; },
            send(body: string) { state.body = body; return res; },
        };
        return { res: res as unknown as Response, state };
    };

    it('uses versioned same-origin JS and CSS with no retired CDN assets', async () => {
        const brand = makeBrand({ auth: { whoamiUrl: 'https://api.test.example.com/auth/me' }, public: {} });
        const req = makeAppRequest({ brand, user: makeUser() });
        const { res, state } = makeRes();

        await serveUppyPage(req, res, vi.fn());

        expect(state.body).toMatch(/href="\/uppy\.css\?v=[a-zA-Z0-9_-]+"/);
        expect(state.body).toMatch(/\.\/uppyModal\.js\?v=[a-zA-Z0-9_-]+/);
        expect(state.body).not.toContain('UPPY_ASSET_VERSION');
        expect(state.body).not.toMatch(/releases\.transloadit\.com|cdnjs\.cloudflare\.com|sweetalert2/i);
        expect(state.body).not.toContain('nomodule');
    });
});

describe('Uppy asset routes - real source-mode bundle', () => {
    const makeRes = () => {
        const state = { statusCode: 200, headers: {} as Record<string, string>, body: '' };
        const res = {
            set(name: string, value: string) { state.headers[name] = value; return res; },
            setHeader(name: string, value: string) { state.headers[name] = value; return res; },
            type(value: string) { state.headers['Content-Type'] = value; return res; },
            status(code: number) { state.statusCode = code; return res; },
            send(body: string) { state.body = body; return res; },
            sendFile() { throw new Error('source-mode test unexpectedly found a prebuilt asset'); },
        };
        return { res: res as unknown as Response, state };
    };

    it('bundles JavaScript without browser-unresolvable Uppy imports', async () => {
        const { res, state } = makeRes();
        await serveUppyModalJs({} as AppRequest, res, vi.fn());

        expect(state.statusCode).toBe(200);
        expect(state.headers['Cache-Control']).toBe('no-store');
        expect(state.body.length).toBeGreaterThan(100_000);
        expect(state.body).not.toMatch(/from\s*["']@uppy\//);
    }, 20_000);

    it('bundles Dashboard, URL, and Image Editor styles', async () => {
        const { res, state } = makeRes();
        await serveUppyCss({} as AppRequest, res, vi.fn());

        expect(state.statusCode).toBe(200);
        expect(state.headers['Cache-Control']).toBe('no-store');
        expect(state.body).toContain('.uppy-Dashboard');
        expect(state.body).toContain('.uppy-Url');
        expect(state.body).toContain('.uppy-ImageCropper');
    }, 20_000);
});

describe('assetCacheControl', () => {
    it('allows immutable caching only for version-stamped asset URLs', () => {
        expect(assetCacheControl('a5f35d7ce668625f')).toBe('public, max-age=31536000, immutable');
        expect(assetCacheControl('dev')).toBe('public, max-age=31536000, immutable');
    });

    // A bare /uppyModal.js request has no cache-busting mechanism: immutable
    // there would pin any unversioned consumer to a stale bundle for a year.
    it('falls back to short-lived caching when the version is absent or malformed', () => {
        expect(assetCacheControl(undefined)).toBe('public, max-age=300');
        expect(assetCacheControl('')).toBe('public, max-age=300');
        expect(assetCacheControl(['a', 'b'])).toBe('public, max-age=300');
    });
});
