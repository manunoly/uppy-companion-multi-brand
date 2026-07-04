import { getS3Client } from '../../lib/aws/s3Client.js';
import { loadBrandSecrets } from '../../lib/secrets.js';
import type { Brand, CompanionBrandConfig, CompanionS3Config } from './brand.contract.js';
import { companionBrandConfigSchema } from './brand.schema.js';
import { resolveEffectiveAuth } from './identity.js';
import { getBaseBrandConfig, getServableSlugs } from './registry.js';
import type { BrandSlug } from './slugs.js';

/**
 * `createBrandRegistry`/`resolveBrand` over the brand contract. Landed here by
 * the Task 2.7 atomic cutover (renamed from `brand.service.next.ts`, which
 * coexisted with the legacy CSV/JSON-based `brand.service.ts` until every
 * consumer — `server.ts`/`config/env.ts` in particular — moved onto it).
 *
 * Secrets (S3 credentials + OAuth provider keys) are loaded via
 * `loadBrandSecrets(slug)` (Fase 6, `src/lib/secrets.ts`), which picks
 * between the `env` (Railway service vars, default) and `aws` (Secrets
 * Manager) sources per `SECRETS_SOURCE` and fails fast if a servable brand
 * ends up without a usable S3 bucket/region (and, under the `env` source,
 * without S3 credentials — see `finalizeBrandSecrets` in `secrets.ts`).
 */
export interface ResolveBrandOptions {
    /** Global Companion secret (COMPANION_SECRET) — one value shared by every brand. */
    secret?: string;
    /** Injectable for tests; defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Resolves one servable brand: base registry config -> `<SLUG>_BRAND_OVERRIDE`
 * (`identity.ts`, auth fields only) -> S3 credentials + OAuth provider
 * secrets (`loadBrandSecrets`) -> fully-formed `Brand` with an initialized
 * `S3Client`.
 */
export function resolveBrand(slug: BrandSlug, options: ResolveBrandOptions = {}): Brand {
    const env = options.env ?? process.env;
    const base: CompanionBrandConfig = getBaseBrandConfig(slug);
    // Structural sanity check — throws on a malformed registry entry (defense in depth; the registry
    // itself is a static, code-reviewed literal, so this should never actually fail in practice).
    companionBrandConfigSchema.parse(base);

    const auth = resolveEffectiveAuth(base);
    const { s3: loadedS3, providers } = loadBrandSecrets(slug, { env });

    // `loadBrandSecrets` guarantees bucket/region are set (it throws otherwise — see
    // `finalizeBrandSecrets`), but `BrandS3Secrets` types them as optional since the
    // `aws`-source raw payload doesn't. Narrow explicitly rather than widening the
    // shared type or asserting with `!`.
    if (!loadedS3.bucket || !loadedS3.region) {
        throw new Error(`[brand] loadBrandSecrets returned no bucket/region for "${slug}" — this should be unreachable`);
    }
    const s3: CompanionS3Config = {
        bucket: loadedS3.bucket,
        region: loadedS3.region,
        accessKey: loadedS3.accessKey,
        secretKey: loadedS3.secretKey,
        useAccelerateEndpoint: loadedS3.useAccelerateEndpoint,
    };

    const client = getS3Client({ regionParam: s3.region, accessKeyIdParam: s3.accessKey, secretAccessKeyParam: s3.secretKey });

    return {
        ...base,
        auth,
        providers,
        secret: options.secret ?? env.COMPANION_SECRET ?? base.secret,
        s3: { ...s3, client },
    };
}

/**
 * Runtime brand registry: every servable slug resolved into a fully-formed
 * `Brand` (secrets loaded, `S3Client` initialized). Distinct from
 * `BrandRegistry` (`brand.contract.ts`), which is the declarative, pre-secret
 * base registry keyed by EVERY known slug (including non-servable ones).
 */
export type ResolvedBrandRegistry = Readonly<Partial<Record<BrandSlug, Brand>>>;

/** Resolves every servable brand (non-empty `companionHosts`) into a frozen slug -> Brand map. */
export function createBrandRegistry(options: ResolveBrandOptions = {}): ResolvedBrandRegistry {
    const entries = getServableSlugs().map((slug) => [slug, resolveBrand(slug, options)] as const);
    return Object.freeze(Object.fromEntries(entries)) as ResolvedBrandRegistry;
}

/** All resolved brands in a `ResolvedBrandRegistry`, in slug-key iteration order. */
export function getAllBrands(registry: ResolvedBrandRegistry): Brand[] {
    return Object.values(registry).filter((brand): brand is Brand => brand !== undefined);
}
