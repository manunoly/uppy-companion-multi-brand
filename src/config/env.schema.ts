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

    // Companion's own local temp-file storage path (brand-independent).
    filePath: z.string().min(1).default('/tmp/'),
});

export type EnvConfig = z.infer<typeof envSchema>;
