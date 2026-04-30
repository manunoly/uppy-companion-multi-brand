import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractToken, authenticate } from './auth.service.js';
import { makeBrand, makeAppRequest } from '../../test-utils/fixtures.js';

describe('extractToken', () => {
    it('returns the token when Authorization: Bearer is present', () => {
        const headers: Record<string, string> = { authorization: 'Bearer xyz123' };
        const req = makeAppRequest({
            get: (n: string) => headers[n.toLowerCase()],
        } as never);
        expect(extractToken(req, makeBrand())).toBe('xyz123');
    });

    it('returns the cookie token when Authorization is absent', () => {
        const req = makeAppRequest({ cookies: { session: 'cookietok' } } as never);
        expect(extractToken(req, makeBrand())).toBe('cookietok');
    });

    it('Authorization header wins over cookie', () => {
        const headers: Record<string, string> = { authorization: 'Bearer headertok' };
        const req = makeAppRequest({
            cookies: { session: 'cookietok' },
            get: (n: string) => headers[n.toLowerCase()],
        } as never);
        expect(extractToken(req, makeBrand())).toBe('headertok');
    });

    it('returns null when neither header nor cookie set', () => {
        const req = makeAppRequest();
        expect(extractToken(req, makeBrand())).toBeNull();
    });

    it('rejects non-Bearer Authorization schemes', () => {
        const headers: Record<string, string> = { authorization: 'Basic dXNlcjpwYXNz' };
        const req = makeAppRequest({
            get: (n: string) => headers[n.toLowerCase()],
        } as never);
        expect(extractToken(req, makeBrand())).toBeNull();
    });

    it('does not honor ?bearerToken= query (OWASP V8.3.1)', () => {
        const req = makeAppRequest({ query: { bearerToken: 'qtok' } } as never);
        expect(extractToken(req, makeBrand())).toBeNull();
    });

    it('reads cookie under brand-specific cookieName', () => {
        const req = makeAppRequest({ cookies: { custom_session: 'mycookie' } } as never);
        const brand = makeBrand({ auth: { url: 'https://x', cookieName: 'custom_session' } });
        expect(extractToken(req, brand)).toBe('mycookie');
    });
});

describe('authenticate', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('returns authenticated:true with user when backend returns OK + valid JSON', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'u1', email: 'test@example.com', roles: ['admin'] }),
        });
        const result = await authenticate('tok', makeBrand());
        expect(result.authenticated).toBe(true);
        expect(result.user?.id).toBe('u1');
        expect(result.user?.email).toBe('test@example.com');
        expect(result.user?.roles).toEqual(['admin']);
    });

    it('coerces numeric id to string', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 42 }),
        });
        const result = await authenticate('tok', makeBrand());
        expect(result.user?.id).toBe('42');
    });

    it('returns authenticated:true with user:null when backend OK but JSON fails schema', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ unknownField: 'oops' }),
        });
        const result = await authenticate('tok', makeBrand());
        expect(result.authenticated).toBe(true);
        expect(result.user).toBeNull();
    });

    it('returns authenticated:false on non-ok response', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: false,
            status: 401,
        });
        const result = await authenticate('tok', makeBrand());
        expect(result.authenticated).toBe(false);
        expect(result.user).toBeNull();
    });

    it('returns authenticated:false when fetch throws (network error)', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const result = await authenticate('tok', makeBrand());
        expect(result.authenticated).toBe(false);
    });

    it('returns authenticated:true with user:null when brand has no auth.url (auth disabled)', async () => {
        const result = await authenticate('tok', makeBrand({ auth: { url: null, cookieName: 'session' } }));
        expect(result.authenticated).toBe(true);
        expect(result.user).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('forwards token to backend as Cookie header (not Authorization)', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'u' }),
        });
        await authenticate('tok123', makeBrand());
        const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(fetchCall[1]?.headers?.Cookie).toBe('session=tok123');
    });
});
