import type { BrandRegistry, CompanionBrandConfig } from './brand.contract.js';
import { BRAND_SLUGS, type BrandSlug } from './slugs.js';

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value as Record<string, unknown>)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }
        Object.freeze(value);
    }
    return value;
}

/**
 * Base registry: one `CompanionBrandConfig` per known slug, in code, deep-frozen.
 * Ported from abeduls3's `packages/brands/src/registry.ts` pattern, adapted to
 * the Companion-only contract (companionHosts, assets.s3Prefix, upload, limits,
 * s3, providers, secret — see brand.contract.ts).
 *
 * `edo` is the MVP brand (spec §5): fully populated, servable (non-empty
 * companionHosts). `abe`/`picaboo` are NOT servable yet — `companionHosts: []`
 * on purpose (empty array, not absent, to satisfy the type) until their
 * external whoami endpoints are confirmed (D5.b for abe/capsule; picaboo has
 * no confirmed partner data at all). We do NOT invent a capsule whoamiUrl for
 * abe — see the empty placeholders below, clearly marked.
 */
const BASE_REGISTRY: BrandRegistry = deepFreeze({
    [BRAND_SLUGS.ENTOURAGE]: {
        slug: BRAND_SLUGS.ENTOURAGE,
        name: 'Entourage',
        domains: ['linkdesigner.entourageyearbooks.com'],
        // SA2: Companion's own hosts (prod + stage). Code-only — the override
        // mechanism (identity.ts) can never touch this field.
        companionHosts: ['companion.entourageyearbooks.com', 'companion.stage.entourageyearbooks.com'],
        auth: {
            kind: 'partner-whoami',
            signInUrl: 'https://edonext.entourageyearbooks.com/login',
            signOutUrl: 'https://edonext-app.entourageyearbooks.com/logout',
            whoamiUrl: 'https://edonext-app.entourageyearbooks.com/api/user',
            whoamiAllowedHosts: ['entourageyearbooks.com'],
            sessionCookieName: 'auth_session',
            responseMapping: { idField: 'id', emailField: 'email', nameField: 'name', imageField: 'profile_photo_url' },
        },
        // SA1: edo's S3 uses 'original/{id}/...' directly — no 'brands/edo/' prefix.
        assets: { s3Prefix: '' },
        upload: { plugins: ['Facebook', 'Url'], system: 'ENTOURAGE', systemDetails: 'DESIGNER' },
        limits: { maxUploadBytes: 50 * 1024 * 1024 },
        companionUrl: 'https://companion.entourageyearbooks.com',
        secret: '', // resolved from COMPANION_SECRET in brand.service.next.ts
        s3: { bucket: 'entourage-uploads', region: 'us-east-1' },
        providers: {},
    } satisfies CompanionBrandConfig,

    [BRAND_SLUGS.ABEDULS]: {
        slug: BRAND_SLUGS.ABEDULS,
        name: 'Abeduls',
        domains: ['designer.abeduls.com', 'designer3.abeduls.com', 'designer.abeduls.local'],
        // Not servable: abe's capsule is an internal endpoint in abeduls3's
        // designer app. The Companion (standalone) would need an EXTERNAL
        // whoami endpoint for capsule (spec D5.b) that is not yet confirmed —
        // left empty on purpose rather than inventing one.
        companionHosts: [],
        auth: {
            kind: 'capsule',
            signInUrl: '',
            whoamiUrl: '',
            whoamiAllowedHosts: [],
            sessionCookieName: 'abes_session',
            responseMapping: { idField: 'id', emailField: 'email', nameField: 'displayName', imageField: 'imageUrl' },
        },
        assets: { s3Prefix: 'brands/abe/' },
        upload: { plugins: [], system: 'ABEDULS', systemDetails: 'DESIGNER' },
        limits: { maxUploadBytes: 50 * 1024 * 1024 },
        companionUrl: '',
        secret: '',
        s3: { bucket: '', region: 'us-east-1' },
        providers: {},
    } satisfies CompanionBrandConfig,

    [BRAND_SLUGS.PICABOO]: {
        slug: BRAND_SLUGS.PICABOO,
        name: 'Picaboo',
        domains: ['designer.picaboo.com'],
        // Not servable: no confirmed partner endpoint yet.
        companionHosts: [],
        auth: {
            kind: 'partner-whoami',
            signInUrl: '',
            whoamiUrl: '',
            whoamiAllowedHosts: [],
            sessionCookieName: 'picaboo_session',
            responseMapping: { idField: 'id', emailField: 'email', nameField: 'name', imageField: 'avatar' },
        },
        assets: { s3Prefix: 'brands/picaboo/' },
        upload: { plugins: [], system: 'PICABOO', systemDetails: 'DESIGNER' },
        limits: { maxUploadBytes: 50 * 1024 * 1024 },
        companionUrl: '',
        secret: '',
        s3: { bucket: '', region: 'us-east-1' },
        providers: {},
    } satisfies CompanionBrandConfig,
});

/** Returns the base (pre-override, pre-secrets) config for a known slug. */
export function getBaseBrandConfig(slug: BrandSlug): CompanionBrandConfig {
    return BASE_REGISTRY[slug];
}

/** Every slug in the base registry. */
export function getAllBrandSlugs(): readonly BrandSlug[] {
    return Object.keys(BASE_REGISTRY) as BrandSlug[];
}

/** Slugs the Companion actually serves (non-empty `companionHosts`). */
export function getServableSlugs(): readonly BrandSlug[] {
    return getAllBrandSlugs().filter((slug) => BASE_REGISTRY[slug].companionHosts.length > 0);
}
