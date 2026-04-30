import { describe, it, expect, vi } from 'vitest';
import { corsForBrand } from './cors.js';
import { makeBrand, makeBrandWithoutAuth } from '../test-utils/fixtures.js';
import type { Request, Response } from 'express';

const makeReq = (origin?: string, method = 'GET') => {
    const headers: Record<string, string> = {};
    if (origin) headers.origin = origin;
    return {
        method,
        get: (n: string) => headers[n.toLowerCase()],
    } as unknown as Request;
};

const makeRes = () => {
    const headers: Record<string, string> = {};
    const res = {
        setHeader: vi.fn((k: string, v: string) => { headers[k.toLowerCase()] = v; }),
        getHeader: (k: string) => headers[k.toLowerCase()],
        status: vi.fn().mockReturnThis(),
        end: vi.fn().mockReturnThis(),
        vary: vi.fn((h: string) => {
            const existing = headers.vary ?? '';
            headers.vary = existing ? `${existing}, ${h}` : h;
        }),
    };
    return { res: res as unknown as Response, headers };
};

describe('corsForBrand', () => {
    it('returns a no-op middleware when brand.rootDomain is null', () => {
        const middleware = corsForBrand(makeBrandWithoutAuth(), 'http');
        const { res, headers } = makeRes();
        const next = vi.fn();
        middleware(makeReq('https://x.example.com'), res, next);
        expect(next).toHaveBeenCalled();
        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('echoes a valid HTTPS origin under rootDomain', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        const next = vi.fn();
        middleware(makeReq('https://app.acme.example.com'), res, next);
        expect(headers['access-control-allow-origin']).toBe('https://app.acme.example.com');
        expect(headers['access-control-allow-credentials']).toBe('true');
        expect(next).toHaveBeenCalled();
    });

    it('rejects HTTP origin under rootDomain in production (envProtocol=https)', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        const next = vi.fn();
        middleware(makeReq('http://app.acme.example.com'), res, next);
        expect(headers['access-control-allow-origin']).toBeUndefined();
        expect(next).toHaveBeenCalled();
    });

    it('accepts HTTP origin under rootDomain in dev (envProtocol=http)', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'http');
        const { res, headers } = makeRes();
        const next = vi.fn();
        middleware(makeReq('http://app.acme.example.com'), res, next);
        expect(headers['access-control-allow-origin']).toBe('http://app.acme.example.com');
    });

    it('accepts http://localhost in dev', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'http');
        const { res, headers } = makeRes();
        middleware(makeReq('http://localhost:3000'), res, vi.fn());
        expect(headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('rejects http://localhost in prod', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        middleware(makeReq('http://localhost:3000'), res, vi.fn());
        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('accepts a subdomain whose leftmost label happens to look like an attacker host', () => {
        // The origin IS a real subdomain of acme.example.com (suffix matches),
        // so it MUST be accepted. The actual bypass attack — placing the
        // rootDomain on the LEFT of an attacker-controlled host like
        // `https://acme.example.com.evil.com` — is covered by the next test.
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        middleware(makeReq('https://evil.com.acme.example.com'), res, vi.fn());
        expect(headers['access-control-allow-origin']).toBe('https://evil.com.acme.example.com');
    });

    it('rejects evil domain that has rootDomain as a substring (not suffix)', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        middleware(makeReq('https://acme.example.com.evil.com'), res, vi.fn());
        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects when the apex domain is requested without subdomain', () => {
        // Regex requires at least one subdomain label before <rootDomain>.
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        middleware(makeReq('https://acme.example.com'), res, vi.fn());
        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('passes through silently when no Origin header (same-origin/non-CORS)', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        const next = vi.fn();
        middleware(makeReq(undefined), res, next);
        expect(headers['access-control-allow-origin']).toBeUndefined();
        expect(next).toHaveBeenCalled();
    });

    it('OPTIONS preflight returns 204 with full headers', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        const next = vi.fn();
        middleware(makeReq('https://app.acme.example.com', 'OPTIONS'), res, next);
        expect(res.status).toHaveBeenCalledWith(204);
        expect(res.end).toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
        expect(headers['access-control-allow-methods']).toContain('GET');
        expect(headers['access-control-allow-methods']).toContain('POST');
        expect(headers['access-control-allow-methods']).toContain('DELETE');
        expect(headers['access-control-allow-methods']).toContain('OPTIONS');
        expect(headers['access-control-allow-headers']).toBe('Content-Type');
        expect(headers['access-control-max-age']).toBe('600');
    });

    it('uses res.vary("Origin") so Vary merges with existing values', () => {
        const brand = makeBrand({ rootDomain: 'acme.example.com' });
        const middleware = corsForBrand(brand, 'https');
        const { res } = makeRes();
        middleware(makeReq('https://app.acme.example.com'), res, vi.fn());
        expect((res as unknown as { vary: ReturnType<typeof vi.fn> }).vary).toHaveBeenCalledWith('Origin');
    });

    it('case-insensitive origin matching (Allow-Origin echoes original casing)', () => {
        const brand = makeBrand({ rootDomain: 'Acme.Example.Com' });
        const middleware = corsForBrand(brand, 'https');
        const { res, headers } = makeRes();
        middleware(makeReq('https://APP.ACME.EXAMPLE.COM'), res, vi.fn());
        expect(headers['access-control-allow-origin']).toBe('https://APP.ACME.EXAMPLE.COM');
    });
});
