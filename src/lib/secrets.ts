import { z } from 'zod';
import { logger } from './logger.js';
import { companionProvidersSchema } from '../modules/brand/brand.schema.js';
import { getBaseBrandConfig, getServableSlugs } from '../modules/brand/registry.js';
import type { CompanionProviderConfig, CompanionProviders } from '../modules/brand/brand.contract.js';
import type { BrandSlug } from '../modules/brand/slugs.js';

/**
 * Per-brand secrets loading (Fase 6, Task 6.1 of the abeduls3-alignment
 * plan). Two sources, selected by `SECRETS_SOURCE`:
 *
 * - `env` (default — Railway): reads per-brand S3/OAuth credentials directly
 *   from process env vars, i.e. Railway *service variables* in production.
 *   Fully synchronous — see `.env.example` for the full per-brand scheme.
 * - `aws` (optional): reads a single JSON secret per brand from AWS Secrets
 *   Manager (`GetSecretValueCommand`). `@aws-sdk/client-secrets-manager` is
 *   loaded via a *dynamic* `import()` so Railway deployments (the default)
 *   never load/initialize that SDK at all.
 *
 * IMPORTANT — why `loadBrandSecrets` below is synchronous even for the `aws`
 * source: `brand.service.ts#resolveBrand`/`createBrandRegistry` are called
 * SYNCHRONOUSLY by `server.ts#createServer` (out of scope for this task).
 * Rather than make the whole brand-resolution chain async — which would
 * ripple into `server.ts`/`index.ts` — the `aws` source warms an in-memory
 * cache ONCE via a top-level `await` at the bottom of this module. Node's ESM
 * loader guarantees that any module which (transitively) statically imports
 * this one — `brand.service.ts` -> `server.ts` -> `index.ts` — has its own
 * evaluation deferred until that top-level await settles, so by the time
 * `createServer()` runs, the cache is already warm and `loadBrandSecrets()`
 * can stay a plain, synchronous cache lookup. The warmup logic itself
 * (`warmSecretsAtBootIfNeeded`/`warmAwsBrandSecretsCache`) is exported so
 * tests can drive it explicitly, independent of module-load timing.
 */

export type SecretsSource = 'env' | 'aws';

export interface BrandS3Secrets {
    readonly accessKey?: string;
    readonly secretKey?: string;
    readonly bucket?: string;
    readonly region?: string;
    readonly useAccelerateEndpoint?: boolean;
}

export interface BrandSecrets {
    readonly s3: BrandS3Secrets;
    readonly providers: CompanionProviders;
}

export interface LoadBrandSecretsOptions {
    /** Injectable for tests; defaults to `process.env`. */
    readonly env?: NodeJS.ProcessEnv;
}

type MutableCompanionProviders = { -readonly [K in keyof CompanionProviders]: CompanionProviders[K] };

/** `edo` -> `EDO`, `abe` -> `ABE` (mirrors brand.service.ts's env-var-prefix convention). */
function envPrefix(slug: BrandSlug): string {
    return slug.toUpperCase().replace(/-/g, '_');
}

function parseBool(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    return value.trim().toLowerCase() === 'true';
}

/** Tolerant, defensive parsing (mirrors `detect.ts`'s `BRAND_FORCE` handling) — never throws. */
export function resolveSecretsSource(env: NodeJS.ProcessEnv): SecretsSource {
    return (env.SECRETS_SOURCE ?? 'env').trim().toLowerCase() === 'aws' ? 'aws' : 'env';
}

function readProviderPair(env: NodeJS.ProcessEnv, prefix: string, name: string): CompanionProviderConfig | undefined {
    const key = env[`${prefix}_${name}_KEY`];
    const secret = env[`${prefix}_${name}_SECRET`];
    return key && secret ? { key, secret } : undefined;
}

/**
 * `SECRETS_SOURCE=env` (Railway, default): per-brand credentials as plain
 * process env vars. See `.env.example` for the full per-brand scheme.
 */
function readEnvBrandSecrets(slug: BrandSlug, env: NodeJS.ProcessEnv): BrandSecrets {
    const prefix = envPrefix(slug);
    const providers: MutableCompanionProviders = {};

    const dropbox = readProviderPair(env, prefix, 'DROPBOX');
    if (dropbox) providers.dropbox = dropbox;
    const facebook = readProviderPair(env, prefix, 'FACEBOOK');
    if (facebook) providers.facebook = facebook;
    const instagram = readProviderPair(env, prefix, 'INSTAGRAM');
    if (instagram) providers.instagram = instagram;
    const onedrive = readProviderPair(env, prefix, 'ONEDRIVE');
    if (onedrive) providers.onedrive = onedrive;
    const box = readProviderPair(env, prefix, 'BOX');
    if (box) providers.box = box;
    const unsplash = readProviderPair(env, prefix, 'UNSPLASH');
    if (unsplash) providers.unsplash = unsplash;
    const zoom = readProviderPair(env, prefix, 'ZOOM');
    if (zoom) providers.zoom = zoom;

    const googleClientId = env[`${prefix}_GOOGLE_CLIENT_ID`];
    if (googleClientId) {
        providers.google = {
            clientId: googleClientId,
            clientSecret: env[`${prefix}_GOOGLE_CLIENT_SECRET`] || undefined,
            driveApiKey: env[`${prefix}_GOOGLE_DRIVE_API_KEY`] || undefined,
            photosApiKey: env[`${prefix}_GOOGLE_PHOTOS_API_KEY`] || undefined,
            appId: env[`${prefix}_GOOGLE_APP_ID`] || undefined,
        };
    }

    return {
        s3: {
            accessKey: env[`${prefix}_S3_ACCESS_KEY`] || env.AWS_ACCESS_KEY_ID,
            secretKey: env[`${prefix}_S3_SECRET_KEY`] || env.AWS_SECRET_ACCESS_KEY,
            bucket: env[`${prefix}_S3_BUCKET`],
            region: env[`${prefix}_S3_REGION`],
            useAccelerateEndpoint: parseBool(env[`${prefix}_S3_ACCELERATE_ENDPOINT`]),
        },
        providers,
    };
}

// ---- AWS Secrets Manager (SECRETS_SOURCE=aws) ----

const awsSecretS3Schema = z
    .object({
        accessKey: z.string().optional(),
        secretKey: z.string().optional(),
        bucket: z.string().optional(),
        region: z.string().optional(),
        useAccelerateEndpoint: z.boolean().optional(),
    })
    .strict();

const awsSecretPayloadSchema = z
    .object({
        s3: awsSecretS3Schema.optional(),
        providers: companionProvidersSchema.optional(),
    })
    .strict();

const awsSecretsCache = new Map<BrandSlug, BrandSecrets>();

/**
 * Fetches and validates the single JSON secret for one brand from AWS
 * Secrets Manager. `@aws-sdk/client-secrets-manager` is dynamically imported
 * so it is never loaded/initialized under `SECRETS_SOURCE=env` (Railway).
 */
async function fetchBrandSecretFromAws(slug: BrandSlug, env: NodeJS.ProcessEnv): Promise<BrandSecrets> {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const region = env.SECRETS_MANAGER_REGION || env.AWS_REGION || 'us-east-1';
    const secretId = env[`${envPrefix(slug)}_SECRETS_ID`] || `companion/${slug}`;
    const client = new SecretsManagerClient({ region });

    let secretString: string | undefined;
    try {
        const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
        secretString = response.SecretString;
    } catch (err) {
        throw new Error(
            `[secrets] Failed to fetch AWS Secrets Manager secret "${secretId}" for brand "${slug}": ${(err as Error).message}`,
        );
    }

    if (!secretString) {
        throw new Error(`[secrets] AWS Secrets Manager secret "${secretId}" for brand "${slug}" has no SecretString`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(secretString);
    } catch {
        throw new Error(`[secrets] AWS Secrets Manager secret "${secretId}" for brand "${slug}" is not valid JSON`);
    }

    const payload = awsSecretPayloadSchema.parse(parsed);
    return { s3: payload.s3 ?? {}, providers: payload.providers ?? {} };
}

/**
 * Fetches every listed brand's secret from AWS Secrets Manager and caches it
 * in-memory (keyed by slug). Called automatically at module load time when
 * `SECRETS_SOURCE=aws` (see `warmSecretsAtBootIfNeeded` below) — also
 * exported directly so tests can drive it against a mocked
 * `SecretsManagerClient` without relying on module-load timing.
 */
export async function warmAwsBrandSecretsCache(
    slugs: readonly BrandSlug[] = getServableSlugs(),
    env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    for (const slug of slugs) {
        const secrets = await fetchBrandSecretFromAws(slug, env);
        awsSecretsCache.set(slug, secrets);
    }
    logger.info({ slugs }, '[secrets] Warmed AWS Secrets Manager cache at boot');
}

/** Test-only: clears the AWS secrets cache so a test can exercise the "not warmed yet" fail-fast path. */
export function resetAwsBrandSecretsCacheForTests(): void {
    awsSecretsCache.clear();
}

function readAwsBrandSecrets(slug: BrandSlug): BrandSecrets {
    const cached = awsSecretsCache.get(slug);
    if (!cached) {
        throw new Error(
            `[secrets] No AWS Secrets Manager data cached for brand "${slug}" — warmAwsBrandSecretsCache() must run ` +
                '(and succeed) at boot before resolving brands under SECRETS_SOURCE=aws.',
        );
    }
    return cached;
}

/**
 * Merges the raw per-source secrets with the code-only base registry
 * (bucket/region fallback only — never credentials, per D3/D8) and fails
 * fast on anything a servable brand cannot run without.
 */
function finalizeBrandSecrets(slug: BrandSlug, raw: BrandSecrets, source: SecretsSource): BrandSecrets {
    const base = getBaseBrandConfig(slug);
    const bucket = raw.s3.bucket || base.s3.bucket;
    const region = raw.s3.region || base.s3.region;
    const accessKey = raw.s3.accessKey ?? base.s3.accessKey;
    const secretKey = raw.s3.secretKey ?? base.s3.secretKey;
    const useAccelerateEndpoint = raw.s3.useAccelerateEndpoint ?? base.s3.useAccelerateEndpoint;

    if (!bucket || !region) {
        throw new Error(
            `[secrets] Missing required S3 bucket/region for brand "${slug}" (source=${source}). Set ` +
                `${envPrefix(slug)}_S3_BUCKET/${envPrefix(slug)}_S3_REGION (env source), the brand's Secrets Manager ` +
                'entry (aws source), or hardcode them in the base registry (registry.ts).',
        );
    }

    // Railway has no instance IAM role (D8) — the Default Credential Provider
    // Chain fallback only makes sense for the `aws` source (real AWS infra).
    if (source === 'env' && (!accessKey || !secretKey)) {
        throw new Error(
            `[secrets] Missing required S3 credentials for brand "${slug}" (SECRETS_SOURCE=env). Set ` +
                `${envPrefix(slug)}_S3_ACCESS_KEY/${envPrefix(slug)}_S3_SECRET_KEY (or the global ` +
                'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY).',
        );
    }

    return {
        s3: { bucket, region, accessKey, secretKey, useAccelerateEndpoint },
        providers: { ...base.providers, ...raw.providers },
    };
}

/**
 * Loads one brand's S3 credentials + OAuth provider secrets, from whichever
 * source `SECRETS_SOURCE` selects (`env` default / Railway, or `aws` /
 * Secrets Manager). Always synchronous — see the module-level comment above
 * for why the `aws` source doesn't need `await` here. Fails fast (throws) if
 * a servable brand ends up without a usable S3 bucket/region, or — under the
 * `env` source only — without S3 credentials.
 */
export function loadBrandSecrets(slug: BrandSlug, options: LoadBrandSecretsOptions = {}): BrandSecrets {
    const env = options.env ?? process.env;
    const source = resolveSecretsSource(env);
    const raw = source === 'aws' ? readAwsBrandSecrets(slug) : readEnvBrandSecrets(slug, env);
    return finalizeBrandSecrets(slug, raw, source);
}

/**
 * Boot-time warmup, gated on `SECRETS_SOURCE=aws`. Exported (and factored out
 * of the top-level `await` below) so it has a plain, directly-testable
 * function body instead of only being reachable by re-importing the module.
 */
export async function warmSecretsAtBootIfNeeded(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (resolveSecretsSource(env) !== 'aws') return;
    await warmAwsBrandSecretsCache(getServableSlugs(), env);
}

// A top-level `await` here defers evaluation of every module that
// (transitively) statically imports this one — brand.service.ts ->
// server.ts -> index.ts — until the cache is warm (see the module-level
// comment above). Skipped entirely under the default `SECRETS_SOURCE=env`
// (Railway), so Railway deployments never load `@aws-sdk/client-secrets-manager`.
await warmSecretsAtBootIfNeeded();
