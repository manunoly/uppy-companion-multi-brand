import { z } from 'zod';

/**
 * Environment schema with Zod validation.
 *
 * Task 2.7 (abeduls3-alignment cutover) drops the legacy per-brand
 * env-derived config (`COMPANION_BRANDS` CSV, `<SLUG_UPPER_SNAKE>` JSON
 * blobs, global `PUBLIC_*`/`AWS_*`/OAuth-provider fallbacks). Brands are now
 * resolved entirely by `createBrandRegistry()` (modules/brand/brand.service.ts)
 * from the code-only base registry + `<SLUG>_BRAND_OVERRIDE` + per-brand
 * secrets — none of that is part of the global `EnvConfig` anymore. What
 * remains here is genuinely global, brand-independent server config.
 */
export const envSchema = z.object({
    // Server
    port: z.number().int().min(1).default(3020),
    host: z.string().min(1).default('0.0.0.0'),
    protocol: z.enum(['http', 'https']).default('http'),

    // Public URL
    publicHost: z.string().min(1),

    // Secret
    secret: z.string().min(16),
    healthCheckKey: z.string().min(1).optional(),

    // Redis (shared state: readiness checks, and in later phases sessions/
    // breaker/rate-limit). Provided by Railway's Redis plugin in production;
    // defaults to a local dev instance so `pnpm dev`/tests don't need one set.
    redisUrl: z.string().min(1).default('redis://localhost:6379'),

    // Per-brand secrets source (Fase 6, `src/lib/secrets.ts#loadBrandSecrets`):
    // `env` (default, Railway service variables) or `aws` (AWS Secrets
    // Manager, one JSON secret per brand). See `.env.example` for the full
    // per-brand variable scheme. Brand-independent — selects HOW every
    // brand's S3/OAuth secrets are loaded, not brand-specific values
    // themselves, so it belongs in the global `EnvConfig` unlike the actual
    // secrets (which are read directly from `process.env`/Secrets Manager at
    // brand-resolution time, not through this schema).
    secretsSource: z.enum(['env', 'aws']).default('env'),

    // Companion's own local temp-file storage path (brand-independent).
    filePath: z.string().min(1).default('/tmp/'),

    // Rate limiting (Fase 5.2, D13): express-rate-limit + rate-limit-redis on
    // /api/* and /uppy, keyed by brand+user/IP. Brand-independent process-wide
    // defaults; generous enough not to bite normal usage while still capping
    // abuse of the (network-bound) whoami/S3-signing endpoints.
    rateLimitWindowMs: z.number().int().positive().default(60_000),
    rateLimitMax: z.number().int().positive().default(300),

    // Global per-IP rate limit (MEDIO-1, security review 2026-07-02): mounted
    // BEFORE express-session/attachUser so it bounds the whoami-fetch DoS
    // surface for EVERY brand route (incl. `/`, OAuth, `/s3`) and `/api/brands`,
    // not just `/uppy`/`/api/*` (which the per-brand+user limiter above already
    // covers, but only after attachUser has already paid the whoami-fetch cost).
    // Deliberately more generous than the per-route limit above since it's a
    // coarse first line of defense shared across every path, not a
    // per-endpoint budget — `/api/healthz`/`/api/readyz` are exempted via
    // `skip` (see server.ts#buildGlobalRateLimiter), not by being cheaper.
    rateLimitGlobalWindowMs: z.number().int().positive().default(60_000),
    rateLimitGlobalMax: z.number().int().positive().default(600),
});

export type EnvConfig = z.infer<typeof envSchema>;
