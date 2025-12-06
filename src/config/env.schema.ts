import { z } from 'zod';

/**
 * Environment schema with Zod validation
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

    // File storage
    filePath: z.string().min(1).default('/tmp/'),

    // CORS origins (comma-separated)
    corsOrigins: z.array(z.string()).default([]),

    // Brands (comma-separated slugs)
    brands: z.string().min(1).default('default'),
});

export type EnvConfig = z.infer<typeof envSchema>;
