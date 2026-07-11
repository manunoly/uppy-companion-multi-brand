import { z } from 'zod';
import { BRAND_SLUG_VALUES } from './slugs.js';

/**
 * Zod schemas for the brand contract (`brand.contract.ts`). Landed here by
 * the Task 2.7 atomic cutover of the abeduls3-alignment plan (renamed from
 * `brand.schema.next.ts`, which coexisted with the legacy schema until every
 * consumer — `config/env.ts` in particular — was moved onto the new contract).
 *
 * `identity.ts` remains the sole RUNTIME authority for what actually gets
 * merged from `<SLUG>_BRAND_OVERRIDE` (allowlist, SSRF gate, charset rules,
 * prototype-pollution guard). `brandOverrideSchema` below only gives fast,
 * structural feedback on gross shape errors (wrong types) — it is
 * intentionally permissive (`.passthrough()`) about unknown/protected keys,
 * since those are silently dropped downstream by `resolveEffectiveAuth`,
 * not rejected at parse time.
 */

export const brandResponseMappingSchema = z
    .object({
        idField: z.string().min(1),
        emailField: z.string().min(1),
        nameField: z.string().min(1),
        imageField: z.string().min(1),
    })
    .strict();

const authSharedFields = {
    signInUrl: z.string(),
    signOutUrl: z.string().optional(),
    whoamiUrl: z.string(),
    whoamiAllowedHosts: z.array(z.string()),
    sessionCookieName: z.string().min(1),
    responseMapping: brandResponseMappingSchema,
    requireVerifiedEmail: z.boolean().optional(),
};

export const brandAuthConfigSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('capsule'), ...authSharedFields }).strict(),
    z.object({ kind: z.literal('partner-whoami'), ...authSharedFields }).strict(),
]);

export const edoUploadPluginSchema = z.enum(['Facebook', 'Dropbox', 'GooglePhotosPicker', 'GoogleDrivePicker', 'Url']);

export const companionS3ConfigSchema = z
    .object({
        bucket: z.string(),
        region: z.string(),
        accessKey: z.string().optional(),
        secretKey: z.string().optional(),
        useAccelerateEndpoint: z.boolean().optional(),
    })
    .strict();

const providerConfigSchema = z.object({ key: z.string(), secret: z.string() }).strict();

const googleProviderConfigSchema = z
    .object({
        clientId: z.string(),
        clientSecret: z.string().optional(),
        driveApiKey: z.string().optional(),
        photosApiKey: z.string().optional(),
        appId: z.string().optional(),
    })
    .strict();

export const companionProvidersSchema = z
    .object({
        google: googleProviderConfigSchema.optional(),
        dropbox: providerConfigSchema.optional(),
        facebook: providerConfigSchema.optional(),
        instagram: providerConfigSchema.optional(),
        onedrive: providerConfigSchema.optional(),
        box: providerConfigSchema.optional(),
        unsplash: providerConfigSchema.optional(),
        zoom: providerConfigSchema.optional(),
    })
    .strict();

/** Structural validation for a declarative `CompanionBrandConfig` (registry entry or resolved Brand). */
export const companionBrandConfigSchema = z.object({
    slug: z.enum(BRAND_SLUG_VALUES),
    name: z.string().min(1),
    domains: z.array(z.string()),
    companionHosts: z.array(z.string()),
    auth: brandAuthConfigSchema,
    assets: z.object({ s3Prefix: z.string() }).strict(),
    upload: z
        .object({
            plugins: z.array(edoUploadPluginSchema),
            system: z.string().min(1),
            systemDetails: z.string().min(1),
        })
        .strict(),
    limits: z
        .object({
            maxUploadBytes: z.number().positive(),
            allowedContentTypes: z.array(z.string()).optional(),
        })
        .strict(),
    public: z.object({ foldersUrl: z.string().optional() }).strict().optional(),
    ingest: z.object({ url: z.string().min(1), tokenEnv: z.string().min(1) }).strict().optional(),
    companionUrl: z.string(),
    secret: z.string(),
    s3: companionS3ConfigSchema,
    providers: companionProvidersSchema,
});

/**
 * Structural validation for the raw `<SLUG>_BRAND_OVERRIDE` JSON. Only `auth`
 * fields are ever mergeable (D3); every other top-level key is passthrough
 * here (identity.ts's `resolveEffectiveAuth` is what actually enforces the
 * allowlist and drops anything it doesn't recognize).
 */
export const brandOverrideAuthSchema = z
    .object({
        kind: z.string().optional(),
        signInUrl: z.string().optional(),
        signOutUrl: z.string().optional(),
        whoamiUrl: z.string().optional(),
        whoamiAllowedHosts: z.array(z.string()).optional(),
        sessionCookieName: z.string().optional(),
    })
    .passthrough();

export const brandOverrideSchema = z
    .object({
        auth: brandOverrideAuthSchema.optional(),
    })
    .passthrough();
