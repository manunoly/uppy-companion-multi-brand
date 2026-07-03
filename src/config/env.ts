import { envSchema, type EnvConfig } from './env.schema.js';

/**
 * Coerces a string to a number with fallback
 */
const coerceNumber = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Derives environment configuration from process.env.
 *
 * Brand configuration is NOT derived here anymore (Task 2.7 cutover) — see
 * `modules/brand/brand.service.ts`'s `createBrandRegistry()`, which reads the
 * code-only base registry + `<SLUG>_BRAND_OVERRIDE` + per-brand secrets
 * directly from `process.env` at brand-resolution time.
 */
const deriveEnv = (): EnvConfig => {
    const port = coerceNumber(process.env.COMPANION_PORT ?? process.env.PORT, 3020);
    const host = process.env.COMPANION_BIND_HOST ?? process.env.HOST ?? '0.0.0.0';
    const protocol = (process.env.COMPANION_PROTOCOL ?? 'http').toLowerCase() as 'http' | 'https';

    const publicHost = process.env.COMPANION_HOST ?? `localhost:${port}`;
    const secret = process.env.COMPANION_SECRET ?? '';
    const healthCheckKey = process.env.HEALTH_CHECK_KEY;
    const filePath = process.env.COMPANION_FILE_PATH ?? '/tmp/';
    const redisUrl = process.env.REDIS_URL;
    const rateLimitWindowMs = coerceNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
    const rateLimitMax = coerceNumber(process.env.RATE_LIMIT_MAX, 300);
    const rateLimitGlobalWindowMs = coerceNumber(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS, 60_000);
    const rateLimitGlobalMax = coerceNumber(process.env.RATE_LIMIT_GLOBAL_MAX, 600);
    // Tolerant/never-throws normalization, mirroring `lib/secrets.ts#resolveSecretsSource`
    // (duplicated on purpose — that module reads raw `process.env` per-call at brand
    // resolution time; this is the one-time, brand-independent boot-time value).
    const secretsSource = (process.env.SECRETS_SOURCE ?? 'env').trim().toLowerCase() === 'aws' ? 'aws' : 'env';

    return envSchema.parse({
        port,
        host,
        protocol,
        publicHost,
        secret,
        healthCheckKey,
        filePath,
        redisUrl,
        rateLimitWindowMs,
        rateLimitMax,
        rateLimitGlobalWindowMs,
        rateLimitGlobalMax,
        secretsSource,
    });
};

/**
 * Validated environment configuration
 */
export const env = deriveEnv();

export type { EnvConfig };
