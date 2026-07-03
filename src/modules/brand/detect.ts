import { getBaseBrandConfig, getServableSlugs } from './registry.js';
import { BRAND_SLUG_VALUES, type BrandSlug, isBrandSlug } from './slugs.js';

/** Lowercases, trims, and strips a trailing `:<port>` from a `Host` header value. */
export function normalizeHost(host: string | null | undefined): string {
    return (host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

export interface ResolveBrandByHostOptions {
    /**
     * Slug returned outside of production when no `BRAND_FORCE`/host match is
     * found. The Companion (unlike abeduls3's single designer app) has no
     * innate default brand across ALL callers — the caller (e.g. the server
     * bootstrap in Fase 5) configures it explicitly per deployment.
     */
    devDefaultSlug?: BrandSlug;
}

/**
 * Resolves the servable brand for an inbound `Host` header. Exact-match
 * against each servable brand's `companionHosts` — ported from abeduls3's
 * `packages/brands/src/detect.ts` pattern (`domains.includes(normalized)`),
 * deliberately NOT the suffix-match of `resolveBrandBySocketHost.ts` (spec D4;
 * abeduls3 tracks that suffix-match as tech debt DES-024).
 *
 * `BRAND_FORCE` always wins (dedicated deploy per brand / apex). An unknown
 * host in production returns `null` — it never falls back to a default brand.
 */
export function resolveBrandByHost(host?: string | null, options: ResolveBrandByHostOptions = {}): BrandSlug | null {
    const force = (process.env.BRAND_FORCE ?? '').trim().toLowerCase();
    if (isBrandSlug(force)) return force;

    const normalized = normalizeHost(host);
    for (const slug of getServableSlugs()) {
        if (getBaseBrandConfig(slug).companionHosts.includes(normalized)) return slug;
    }

    if (process.env.NODE_ENV !== 'production' && options.devDefaultSlug) {
        return options.devDefaultSlug;
    }
    return null;
}

/**
 * Boot-time guard (Hallazgo BAJO-4). `BRAND_FORCE` always wins in
 * `resolveBrandByHost` above, but `createBrandRegistry()` (brand.service.ts)
 * only ever builds a Companion instance for SERVABLE slugs (non-empty
 * `companionHosts`). Without this check, forcing a registered-but-not-yet-
 * servable brand (e.g. `abe`/`picaboo` today) — or a typo that isn't a brand
 * slug at all — would boot "successfully" and then 404 on every single
 * request forever, with nothing in the logs pointing at `BRAND_FORCE` as the
 * cause. Call this once at process startup (see `server.ts#createServer`),
 * never per-request.
 */
export function assertBrandForceIsServable(): void {
    const raw = (process.env.BRAND_FORCE ?? '').trim().toLowerCase();
    if (!raw) return;

    if (!isBrandSlug(raw)) {
        throw new Error(
            `BRAND_FORCE="${raw}" is not a recognized brand slug (expected one of: ${BRAND_SLUG_VALUES.join(', ')})`,
        );
    }

    const servable = getServableSlugs();
    if (!servable.includes(raw)) {
        throw new Error(
            `BRAND_FORCE="${raw}" is not a servable brand (companionHosts is empty in the registry). ` +
            `Servable brands: ${servable.join(', ') || '(none)'}`,
        );
    }
}
