import type { Brand } from '../modules/brand/brand.types.js';

/**
 * Per-brand Content-Security-Policy directive builders (security review
 * finding MEDIO-3).
 *
 * helmet 8's defaults leave `connect-src`/`frame-ancestors`/`frame-src`
 * un-derived (they fall back to `default-src 'self'`), and `img-src`
 * explicitly `'self' data:` — none of which cover what the `/uppy` page
 * actually needs:
 *   - `connect-src`: the direct-to-S3 XHR/fetch PUT the `@uppy/aws-s3`
 *     plugin issues against the brand's presigned bucket URL
 *     (`https://<bucket>.s3.<region>.amazonaws.com`, cross-origin — NOT
 *     `'self'`); the brand's whoami origin (defensive/forward-looking — the
 *     page only carries it as upload metadata today, but the spec calls for
 *     including it); the Google APIs origins the Drive/Photos picker
 *     plugins call when enabled for the brand.
 *   - `frame-ancestors`: the brand's own designer domain(s) (`brand.domains`)
 *     so abeduls3 can embed `/uppy` in an `<iframe>` — `'self'` alone blocks
 *     any cross-origin embed.
 *   - `frame-src`: Google's picker/consent UI, when the picker is enabled.
 *   - `img-src`: `blob:` for Uppy's client-generated thumbnail previews
 *     (`ThumbnailGenerator` renders `<img src="blob:...">`, which the
 *     inherited `'self' data:` default does NOT cover), plus Google's
 *     thumbnail/avatar CDN when the picker is enabled.
 *
 * Every builder is a pure function of `Brand | undefined` — `undefined`
 * covers requests that never resolve a brand (the global `/api/healthz`,
 * `/api/readyz`, `/api/brands` routes, or an unrecognized Host), where the
 * safe minimal default (matching what helmet would have derived on its own)
 * is used.
 *
 * The exact Google origins below are best-effort, derived from Google's
 * documented Picker/Identity integration surface — NOT verified against a
 * live flow (same caveat the design spec flags for other external
 * integration points, docs/superpowers/specs/2026-07-02-...-design.md §2/§8).
 * Follow-up: confirm during the edo stage smoke test and narrow/adjust.
 */

const usesGooglePicker = (brand: Brand): boolean =>
    brand.upload.plugins.includes('GoogleDrivePicker') || brand.upload.plugins.includes('GooglePhotosPicker');

const GOOGLE_API_CONNECT_ORIGINS = ['https://www.googleapis.com', 'https://content.googleapis.com'];
const GOOGLE_PICKER_FRAME_ORIGINS = ['https://docs.google.com', 'https://accounts.google.com'];
const GOOGLE_THUMBNAIL_IMG_ORIGINS = ['https://lh3.googleusercontent.com', 'https://drive.google.com'];
const GOOGLE_SCRIPT_ORIGINS = ['https://apis.google.com'];

// Uppy ships its JS bundle + Dashboard CSS from transloadit; sweetalert2 ships
// its JS + CSS from cdnjs. Both feed script-src AND style-src (uppy.html).
const TRANSLOADIT_ORIGIN = 'https://releases.transloadit.com';
const CDNJS_ORIGIN = 'https://cdnjs.cloudflare.com';

const s3OriginFor = (brand: Brand): string | null => {
    if (!brand.s3.bucket || !brand.s3.region) return null;
    return `https://${brand.s3.bucket}.s3.${brand.s3.region}.amazonaws.com`;
};

const whoamiOriginFor = (brand: Brand): string | null => {
    try {
        return new URL(brand.auth.whoamiUrl).origin;
    } catch {
        // Malformed/empty whoamiUrl — already surfaced by the SSRF gate
        // (identity.ts#resolveValidatedWhoamiTarget) at auth time; silently
        // omit it from CSP rather than injecting garbage into the header.
        return null;
    }
};

/** `connect-src`: same-origin + the brand's S3 bucket + whoami origin + Google APIs (if the picker is enabled). */
export const buildConnectSrc = (brand: Brand | undefined): string => {
    const origins = new Set(["'self'"]);
    if (brand) {
        const s3Origin = s3OriginFor(brand);
        if (s3Origin) origins.add(s3Origin);
        const whoamiOrigin = whoamiOriginFor(brand);
        if (whoamiOrigin) origins.add(whoamiOrigin);
        if (usesGooglePicker(brand)) {
            for (const origin of GOOGLE_API_CONNECT_ORIGINS) origins.add(origin);
        }
    }
    return Array.from(origins).join(' ');
};

/**
 * The brand's designer domain(s) as concrete `https://<host>` origins. Single
 * source of truth for BOTH the `frame-ancestors` CSP directive (who may embed
 * /uppy) AND the postMessage target allow-list injected into the page
 * (`ALLOWED_ANCESTORS_VALUE`, uppy.routes.ts) — the set of origins allowed to
 * embed us is exactly the set we may postMessage back to.
 */
export const brandEmbedOrigins = (brand: Brand | undefined): string[] =>
    brand ? brand.domains.map((domain) => `https://${domain}`) : [];

/** `frame-ancestors`: same-origin + every one of the brand's designer domain(s), so the /uppy page can be embedded there. */
export const buildFrameAncestors = (brand: Brand | undefined): string => {
    const origins = new Set(["'self'", ...brandEmbedOrigins(brand)]);
    return Array.from(origins).join(' ');
};

/** `frame-src`: same-origin + Google's picker/consent UI (if the picker is enabled for the brand). */
export const buildFrameSrc = (brand: Brand | undefined): string => {
    const origins = new Set(["'self'"]);
    if (brand && usesGooglePicker(brand)) {
        for (const origin of GOOGLE_PICKER_FRAME_ORIGINS) origins.add(origin);
    }
    return Array.from(origins).join(' ');
};

/** `img-src`: same-origin + data: + blob: (thumbnail previews) + Google's thumbnail CDN (if the picker is enabled). */
export const buildImgSrc = (brand: Brand | undefined): string => {
    const origins = new Set(["'self'", 'data:', 'blob:']);
    if (brand && usesGooglePicker(brand)) {
        for (const origin of GOOGLE_THUMBNAIL_IMG_ORIGINS) origins.add(origin);
    }
    return Array.from(origins).join(' ');
};

/**
 * `script-src`: same-origin + el nonce por-request de la página /uppy + los
 * CDNs de Uppy (transloadit) y SweetAlert2 (cdnjs) + el loader de Google APIs
 * (`apis.google.com`) cuando la marca habilita el Drive/Photos Picker. El
 * nonce se pasa desde `res.locals.cspNonce` (server.ts) porque helmet resuelve
 * esta directiva por-request.
 */
export const buildScriptSrc = (brand: Brand | undefined, nonce: string): string => {
    const origins = [
        "'self'",
        `'nonce-${nonce}'`,
        TRANSLOADIT_ORIGIN,
        CDNJS_ORIGIN,
    ];
    if (brand && usesGooglePicker(brand)) {
        origins.push(...GOOGLE_SCRIPT_ORIGINS);
    }
    return origins.join(' ');
};

/**
 * `style-src`: same-origin + `'unsafe-inline'` (Uppy's Dashboard injects
 * runtime `<style>`/style attributes that can't be nonced) + the Uppy CDN
 * (`uppy.min.css`, uppy.html:8) + cdnjs (sweetalert2 CSS). Brand-independent —
 * every brand's /uppy loads the same CSS. Returns individual sources (matching
 * the other directive arrays) rather than a joined string because this one is
 * static, not resolved per-request.
 */
export const buildStyleSrc = (): string[] => ["'self'", "'unsafe-inline'", CDNJS_ORIGIN, TRANSLOADIT_ORIGIN];
