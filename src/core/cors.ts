import type { RequestHandler } from 'express';
import type { Brand } from '../modules/brand/brand.types.js';

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (s: string): string => s.replace(REGEX_METACHARS, '\\$&');

/**
 * Per-brand CORS middleware for /api/uppy/* routes.
 *
 * Echoes the request `Origin` when it matches `*.<rootDomain>` with the brand's
 * scheme constraints. In production (envProtocol === 'https') the regex
 * accepts only HTTPS origins — never echo Allow-Credentials to a plain-HTTP
 * page under the brand root, otherwise an attacker on http://anywhere.<root>
 * could read credentialed responses (the Secure cookie still travels because
 * the request URL is HTTPS).
 *
 * In dev (envProtocol === 'http') HTTP is also allowed plus a literal exemption
 * for http://localhost(:port) so the local toolchain works without TLS setup.
 *
 * Returns a no-op middleware when brand.rootDomain is null (auth disabled).
 */
export const corsForBrand = (
    brand: Brand,
    envProtocol: 'http' | 'https',
): RequestHandler => {
    if (!brand.rootDomain) {
        return (_req, _res, next) => next();
    }

    const escaped = escapeRegex(brand.rootDomain);
    const scheme = envProtocol === 'https' ? 'https' : 'https?';
    const rootRegex = new RegExp(
        `^${scheme}://([a-z0-9-]+\\.)+${escaped}(:\\d+)?$`,
        'i',
    );
    const localhostRegex = /^http:\/\/localhost(:\d+)?$/i;

    const isAllowed = (origin: string): boolean => {
        if (rootRegex.test(origin)) return true;
        if (envProtocol === 'http' && localhostRegex.test(origin)) return true;
        return false;
    };

    return (req, res, next) => {
        const origin = req.get('origin');

        // Same-origin or non-CORS request — no headers needed.
        if (!origin) {
            next();
            return;
        }

        if (!isAllowed(origin)) {
            // Origin not in allow-list: do not set CORS headers. The browser
            // will block the response to the JS caller.
            next();
            return;
        }

        res.setHeader('Access-Control-Allow-Origin', origin);
        // Use res.vary() — appends to any existing Vary (e.g. compression
        // middleware adding `Accept-Encoding`) instead of overwriting it.
        res.vary('Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader(
            'Access-Control-Allow-Methods',
            'GET, POST, DELETE, OPTIONS',
        );
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');

        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    };
};
