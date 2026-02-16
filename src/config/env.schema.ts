import { z } from 'zod';
import { brandConfigSchema } from '../modules/brand/brand.schema.js';

const providerDefaultSchema = z.object({
    key: z.string().min(1).optional(),
    secret: z.string().min(1).optional(),
}).strict();

const googleProviderDefaultSchema = z.object({
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    driveApiKey: z.string().min(1).optional(),
    photosApiKey: z.string().min(1).optional(),
    appId: z.string().min(1).optional(),
}).strict();

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
    healthCheckKey: z.string().min(1).optional(),

    // File storage
    filePath: z.string().min(1).default('/tmp/'),

    // CORS origins (comma-separated)
    corsOrigins: z.array(z.string()).default([]),

    // Brands (comma-separated slugs)
    brands: z.string().min(1).default('default'),

    // Global public URLs fallback
    publicBackendUrl: z.string().min(1).optional(),
    publicUploadUrl: z.string().min(1).optional(),
    publicFoldersUrl: z.string().min(1).optional(),

    // Global AWS fallback
    s3Defaults: z.object({
        bucket: z.string().min(1).optional(),
        region: z.string().min(1).optional(),
        accessKey: z.string().min(1).optional(),
        secretKey: z.string().min(1).optional(),
        useAccelerateEndpoint: z.boolean().optional(),
    }).strict(),

    // Global provider fallback
    providerDefaults: z.object({
        google: googleProviderDefaultSchema,
        dropbox: providerDefaultSchema,
        facebook: providerDefaultSchema,
        instagram: providerDefaultSchema,
        onedrive: providerDefaultSchema,
        box: providerDefaultSchema,
        unsplash: providerDefaultSchema,
        zoom: providerDefaultSchema,
    }).strict(),

    // Per-brand JSON configuration (already validated)
    brandConfigs: z.record(z.string(), brandConfigSchema).default({}),
});

export type EnvConfig = z.infer<typeof envSchema>;
