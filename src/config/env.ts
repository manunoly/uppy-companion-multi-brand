import { envSchema, type EnvConfig } from './env.schema.js';

/**
 * Parses a comma-separated string into an array
 */
const parseCsv = (value: string | undefined): string[] => {
    if (!value) return [];
    return value.split(',').map(s => s.trim()).filter(Boolean);
};

/**
 * Coerces a string to a number with fallback
 */
const coerceNumber = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Derives environment configuration from process.env
 */
const deriveEnv = (): EnvConfig => {
    const port = coerceNumber(process.env.COMPANION_PORT ?? process.env.PORT, 3020);
    const host = process.env.COMPANION_BIND_HOST ?? process.env.HOST ?? '0.0.0.0';
    const protocol = (process.env.COMPANION_PROTOCOL ?? 'http').toLowerCase() as 'http' | 'https';

    const publicHost = process.env.COMPANION_HOST ?? `localhost:${port}`;
    const secret = process.env.COMPANION_SECRET ?? '';
    const filePath = process.env.COMPANION_FILE_PATH ?? '/tmp/';

    const corsOrigins = parseCsv(process.env.CORS_ALLOWED_ORIGINS);
    const brands = process.env.COMPANION_BRANDS ?? 'default';

    return envSchema.parse({
        port,
        host,
        protocol,
        publicHost,
        secret,
        filePath,
        corsOrigins,
        brands,
    });
};

/**
 * Validated environment configuration
 */
export const env = deriveEnv();

export type { EnvConfig };
