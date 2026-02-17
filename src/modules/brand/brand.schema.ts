import { z } from 'zod';

const providerConfigSchema = z.object({
    key: z.string().min(1).optional(),
    secret: z.string().min(1).optional(),
}).strict();

const googleProviderConfigSchema = z.object({
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    driveApiKey: z.string().min(1).optional(),
    photosApiKey: z.string().min(1).optional(),
    appId: z.string().min(1).optional(),
    // Legacy aliases accepted for backwards compatibility
    key: z.string().min(1).optional(),
    secret: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
}).strict().transform((value) => ({
    clientId: value.clientId ?? value.key,
    clientSecret: value.clientSecret ?? value.secret,
    driveApiKey: value.driveApiKey ?? value.apiKey,
    photosApiKey: value.photosApiKey ?? value.apiKey,
    appId: value.appId,
}));

const s3ConfigSchema = z.object({
    bucket: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    accessKey: z.string().min(1).optional(),
    secretKey: z.string().min(1).optional(),
    useAccelerateEndpoint: z.boolean().optional(),
}).strict();

/**
 * Runtime schema for validating brand JSON config from environment variables.
 */
export const brandConfigSchema = z.object({
    auth: z.object({
        url: z.string().min(1).optional(),
        cookieName: z.string().min(1).optional(),
    }).strict().optional(),
    public: z.object({
        backendUrl: z.string().min(1).optional(),
        uploadUrl: z.string().min(1).optional(),
        foldersUrl: z.string().min(1).optional(),
    }).strict().optional(),
    authUrl: z.string().min(1).optional(),
    authCookieName: z.string().min(1).optional(),
    publicBackendUrl: z.string().min(1).optional(),
    publicUploadUrl: z.string().min(1).optional(),
    companionUrl: z.string().min(1).optional(),
    corsOrigins: z.array(z.string().min(1)).optional(),
    uploadUrls: z.array(z.string().min(1)).optional(),
    s3: s3ConfigSchema.optional(),
    providers: z.object({
        google: googleProviderConfigSchema.optional(),
        dropbox: providerConfigSchema.optional(),
        facebook: providerConfigSchema.optional(),
        instagram: providerConfigSchema.optional(),
        onedrive: providerConfigSchema.optional(),
        box: providerConfigSchema.optional(),
        unsplash: providerConfigSchema.optional(),
        zoom: providerConfigSchema.optional(),
    }).strict().optional(),
    enabledPlugins: z.string().min(1).optional(),
}).strict();
