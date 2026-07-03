import { getBaseBrandConfig, getServableSlugs } from './registry.js';
import { type BrandSlug, isBrandSlug } from './slugs.js';

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
