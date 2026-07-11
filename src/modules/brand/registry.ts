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
 * `edo` and `abe` are servable (non-empty companionHosts); abe validates the
 * forwarded capsule cookie against an external whoami (D5.b). `picaboo` is NOT
 * servable yet — `companionHosts: []` on purpose (empty array, not absent, to
 * satisfy the type) until its partner data is confirmed. We do NOT invent
 * partner endpoints — see the empty placeholders below, clearly marked.
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
        // Designer hosts (prod + local) allowed to embed /uppy (frame-ancestors) and call the API (CORS).
        domains: ['abeduls.com', 'designer.abeduls.com', 'designer.abeduls.local', 'abeduls.local'],
        // SA2: Companion's own hosts (prod + local). Code-only — the override
        // mechanism (identity.ts) can never touch this field.
        companionHosts: ['companion.abeduls.com', 'companion.abeduls.local'],
        auth: {
            // Standalone Companion validates the forwarded capsule cookie against an
            // EXTERNAL whoami (D5.b) — same flow as any partner; `kind` is cosmetic.
            kind: 'partner-whoami',
            signInUrl: 'https://abeduls.com/sign-in',
            whoamiUrl: 'https://abeduls.com/api/user',
            whoamiAllowedHosts: ['abeduls.com'],
            sessionCookieName: 'abes_session',
            responseMapping: { idField: 'id', emailField: 'email', nameField: 'displayName', imageField: 'imageUrl' },
            // Parity with capsule's proxy gate: an unverified-email user resolves as unauthenticated.
            requireVerifiedEmail: true,
        },
        // SA1: shares capsule's bucket 1:1 — keys land at 'original/{id}/...', no 'brands/abe/' prefix.
        assets: { s3Prefix: '' },
        upload: { plugins: [], system: 'ABEDULS', systemDetails: 'DESIGNER' },
        limits: {
            maxUploadBytes: 50 * 1024 * 1024,
            allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'],
        },
        public: { foldersUrl: 'https://abeduls.com/api/folders' },
        companionUrl: 'https://companion.abeduls.com',
        secret: '', // resolved from COMPANION_SECRET in brand.service.ts
        // bucket + creds arrive via env (ABE_S3_BUCKET/ABE_S3_REGION -> loadBrandSecrets);
        // no literal bucket until the real one is confirmed. region is a sane fallback.
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
