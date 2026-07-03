import { getS3Client } from '../../lib/aws/s3Client.js';
import type { Brand, CompanionBrandConfig } from './brand.contract.js';
import { companionBrandConfigSchema } from './brand.schema.next.js';
import { resolveEffectiveAuth } from './identity.js';
import { getBaseBrandConfig, getServableSlugs } from './registry.js';
import type { BrandSlug } from './slugs.js';

/**
 * `createBrandRegistry`/`resolveBrand` over the NEW contract. Kept as
 * `.next.ts` (Task 2.6) — the atomic cutover (Task 2.7) renames this over the
 * legacy `brand.service.ts`, which `config/env.ts` still imports today.
 *
 * Secrets are loaded from plain env vars here (a stub): Fase 6 replaces this
 * with `loadBrandSecrets(slug)` (`SECRETS_SOURCE=env|aws`). The shape of
 * `ResolveBrandOptions`/the env-var naming below is deliberately close to
 * that future loader so the Fase 6 swap is a small diff.
 */
export interface ResolveBrandOptions {
    /** Global Companion secret (COMPANION_SECRET) — one value shared by every brand. */
    secret?: string;
    /** Injectable for tests; defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
}

function envPrefix(slug: BrandSlug): string {
    return slug.toUpperCase().replace(/-/g, '_');
}

/**
 * Stub S3 credential loader: per-brand env vars (`<SLUG>_AWS_ACCESS_KEY_ID` /
 * `_AWS_SECRET_ACCESS_KEY`) falling back to the global `AWS_*` pair — mirrors
 * the legacy `brand.service.ts` fallback chain. Fase 6 (`loadBrandSecrets`)
 * replaces this with a `SECRETS_SOURCE=env|aws` abstraction.
 */
function readStubS3Secrets(slug: BrandSlug, env: NodeJS.ProcessEnv): { accessKey?: string; secretKey?: string } {
    const prefix = envPrefix(slug);
    return {
        accessKey: env[`${prefix}_AWS_ACCESS_KEY_ID`] ?? env.AWS_ACCESS_KEY_ID,
        secretKey: env[`${prefix}_AWS_SECRET_ACCESS_KEY`] ?? env.AWS_SECRET_ACCESS_KEY,
    };
}

/**
 * Resolves one servable brand: base registry config -> `<SLUG>_BRAND_OVERRIDE`
 * (`identity.ts`, auth fields only) -> S3 credentials from env (stub) ->
 * fully-formed `Brand` with an initialized `S3Client`.
 */
export function resolveBrand(slug: BrandSlug, options: ResolveBrandOptions = {}): Brand {
    const env = options.env ?? process.env;
    const base: CompanionBrandConfig = getBaseBrandConfig(slug);
    // Structural sanity check — throws on a malformed registry entry (defense in depth; the registry
    // itself is a static, code-reviewed literal, so this should never actually fail in practice).
    companionBrandConfigSchema.parse(base);

    const auth = resolveEffectiveAuth(base);
    const stubSecrets = readStubS3Secrets(slug, env);
    const s3 = {
        bucket: base.s3.bucket,
        region: base.s3.region,
        accessKey: base.s3.accessKey ?? stubSecrets.accessKey,
        secretKey: base.s3.secretKey ?? stubSecrets.secretKey,
        useAccelerateEndpoint: base.s3.useAccelerateEndpoint,
    };

    const client = s3.region
        ? getS3Client({ regionParam: s3.region, accessKeyIdParam: s3.accessKey, secretAccessKeyParam: s3.secretKey })
        : undefined;

    return {
        ...base,
        auth,
        secret: options.secret ?? env.COMPANION_SECRET ?? base.secret,
        s3: { ...s3, client },
    };
}

/** Resolves every servable brand (non-empty `companionHosts`) into a frozen slug -> Brand map. */
export function createBrandRegistry(options: ResolveBrandOptions = {}): Readonly<Partial<Record<BrandSlug, Brand>>> {
    const entries = getServableSlugs().map((slug) => [slug, resolveBrand(slug, options)] as const);
    return Object.freeze(Object.fromEntries(entries)) as Readonly<Partial<Record<BrandSlug, Brand>>>;
}
