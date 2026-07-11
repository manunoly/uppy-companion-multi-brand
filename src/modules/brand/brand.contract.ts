import type { S3Client } from '@aws-sdk/client-s3';
import type { BrandSlug } from './slugs.js';

/**
 * New brand contract, reimplemented 1:1 (for the shared parts) from abeduls3's
 * `@package/brands` (`packages/brands/src/types.ts`), plus the Companion-only
 * fields (`s3`, `providers`, `secret`, `companionHosts`, `companionUrl`).
 *
 * This module intentionally does NOT import anything from `./brand.types.js`
 * (the legacy contract) — see docs/superpowers/plans/2026-07-02-companion-
 * multibrand-alineacion-abeduls3.md, Fase 2. It coexists with the legacy
 * contract until the atomic cutover (Task 2.7) replaces it everywhere.
 */

// Declarative mapping from a brand's raw whoami response to the canonical BrandUser.
export interface BrandResponseMapping {
    readonly idField: string;
    readonly emailField: string;
    readonly nameField: string;
    readonly imageField: string;
}

/**
 * Auth configuration for a brand. Unlike abeduls3 (where only `partner-whoami`
 * carries `whoamiUrl`/`whoamiAllowedHosts`), BOTH variants carry them here:
 * the Companion is a standalone service, so even `capsule` brands (abe) need
 * an EXTERNAL whoami endpoint + SSRF allowlist to validate a forwarded cookie
 * (spec D5.b). `whoamiAllowedHosts`, `kind` and `requireVerifiedEmail` are
 * NEVER overridable via `<SLUG>_BRAND_OVERRIDE` (see identity.ts PROTECTED_AUTH_KEYS).
 */
export type BrandAuthConfig =
    | {
          readonly kind: 'capsule';
          readonly signInUrl: string;
          readonly signOutUrl?: string;
          readonly whoamiUrl: string;
          readonly whoamiAllowedHosts: readonly string[];
          readonly sessionCookieName: string;
          readonly responseMapping: BrandResponseMapping;
          // When true, a whoami response whose raw `emailVerified` claim is not `true` resolves as unauthenticated.
          readonly requireVerifiedEmail?: boolean;
      }
    | {
          readonly kind: 'partner-whoami';
          readonly signInUrl: string;
          readonly signOutUrl?: string;
          readonly whoamiUrl: string;
          readonly whoamiAllowedHosts: readonly string[];
          readonly sessionCookieName: string;
          readonly responseMapping: BrandResponseMapping;
          // When true, a whoami response whose raw `emailVerified` claim is not `true` resolves as unauthenticated.
          readonly requireVerifiedEmail?: boolean;
      };

// Safe Uppy Dashboard plugins for the edo UppyModal.js (mirrors abeduls3's EdoUploadPlugin).
export type EdoUploadPlugin = 'Facebook' | 'Dropbox' | 'GooglePhotosPicker' | 'GoogleDrivePicker' | 'Url';

export interface CompanionProviderConfig {
    readonly key: string;
    readonly secret: string;
}

export interface CompanionGoogleProviderConfig {
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly driveApiKey?: string;
    readonly photosApiKey?: string;
    readonly appId?: string;
}

export interface CompanionProviders {
    readonly google?: CompanionGoogleProviderConfig;
    readonly dropbox?: CompanionProviderConfig;
    readonly facebook?: CompanionProviderConfig;
    readonly instagram?: CompanionProviderConfig;
    readonly onedrive?: CompanionProviderConfig;
    readonly box?: CompanionProviderConfig;
    readonly unsplash?: CompanionProviderConfig;
    readonly zoom?: CompanionProviderConfig;
}

export interface CompanionS3Config {
    readonly bucket: string;
    readonly region: string;
    readonly accessKey?: string;
    readonly secretKey?: string;
    readonly useAccelerateEndpoint?: boolean;
}

/**
 * Declarative (unresolved) brand configuration — the shape of a registry entry
 * (registry.ts) before secrets are loaded and before `<SLUG>_BRAND_OVERRIDE`
 * is merged in.
 */
export interface CompanionBrandConfig {
    readonly slug: BrandSlug;
    readonly name: string;
    /** Hosts of the brand's own app/designer (used for CORS). */
    readonly domains: readonly string[];
    /**
     * Hosts the Companion itself answers to (resolution by Host, exact-match).
     * Code-only, never overridable. Empty array = brand not servable yet.
     */
    readonly companionHosts: readonly string[];
    readonly auth: BrandAuthConfig;
    /** Code-only, never overridable — S3 key prefix isolation per brand. */
    readonly assets: { readonly s3Prefix: string };
    readonly upload: {
        readonly plugins: readonly EdoUploadPlugin[];
        readonly system: string;
        readonly systemDetails: string;
    };
    readonly limits: {
        readonly maxUploadBytes: number;
        readonly allowedContentTypes?: readonly string[];
    };
    /** Conserved per SA3 — folders degrade to `[]` when absent. */
    readonly public?: { readonly foldersUrl?: string };
    /**
     * S2S ingest-callback target (registry data, not hardcoded). `url` is the
     * partner's internal ingest endpoint, SSRF-gated at resolution against the
     * brand's `whoamiAllowedHosts` (identity.ts#resolveValidatedIngestTarget);
     * `tokenEnv` names the env var holding the Bearer token, read at CALL-TIME
     * (identity.ts#readIngestToken, throws on empty). Absent = no callback.
     */
    readonly ingest?: { readonly url: string; readonly tokenEnv: string };
    /** Public origin of this Companion instance (source of truth for OAuth redirect_uri). */
    readonly companionUrl: string;
    /** COMPANION_SECRET — same value across brands. */
    readonly secret: string;
    readonly s3: CompanionS3Config;
    readonly providers: CompanionProviders;
}

/** Base registry: one `CompanionBrandConfig` per known slug, deep-frozen. */
export type BrandRegistry = Readonly<Record<BrandSlug, CompanionBrandConfig>>;

/**
 * Fully resolved brand (registry + `<SLUG>_BRAND_OVERRIDE` + secrets loaded).
 * Identical to `CompanionBrandConfig` except `s3.client` is populated once
 * credentials/region are known.
 */
export interface Brand extends Omit<CompanionBrandConfig, 's3'> {
    readonly s3: CompanionS3Config & { readonly client?: S3Client };
}

/**
 * Canonical minimal identity every brand resolver produces (identical shape to
 * abeduls3's `BrandUser`), plus the Companion-only `edoId` extra populated by
 * `enrichEdoUser` (Fase 3) for the `edo` brand. `edoId` is NEVER used for S3
 * keys (SA1) — it exists for metadata/listing purposes only.
 */
export interface BrandUser {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly imageUrl: string | null;
    readonly edoId?: number;
}
