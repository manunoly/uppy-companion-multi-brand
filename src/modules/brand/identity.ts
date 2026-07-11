import { logger } from '../../lib/logger.js';
import type { BrandAuthConfig, BrandResponseMapping, BrandUser, CompanionBrandConfig } from './brand.contract.js';
import type { BrandSlug } from './slugs.js';

/**
 * Override-merge + SSRF-gate logic for the brand auth config. Ported from
 * abeduls3's `packages/brands/src/identity.ts`, generalized where the
 * Companion's contract differs from abeduls3's (see resolveValidatedWhoamiTarget).
 */

export const WHOAMI_TIMEOUT_MS = 5000;
export const WHOAMI_MAX_BODY_BYTES = 16 * 1024;
export const PARTNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_URL_LENGTH = 999;

/** Suffix-match SSRF allowlist check: `h === e || h.endsWith('.' + e)`. */
export function isWhoamiHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
    const h = host.toLowerCase();
    return allowedHosts.some((entry) => {
        const e = entry.toLowerCase();
        return h === e || h.endsWith(`.${e}`);
    });
}

export type WhoamiUrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

export function validateWhoamiUrl(raw: string, allowedHosts: readonly string[]): WhoamiUrlValidation {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'empty/over-length' };
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (url.protocol !== 'https:') return { ok: false, reason: 'non-https' };
    if (url.username || url.password) return { ok: false, reason: 'credentials' };
    // URL() normalizes the default :443 to '', so an explicit :443 passes; only non-default ports are rejected.
    if (url.port) return { ok: false, reason: 'non-default port' };
    if (!url.hostname || !isWhoamiHostAllowed(url.hostname, allowedHosts)) return { ok: false, reason: 'host not allowed' };
    return { ok: true, url };
}

const COOKIE_NAME_FORBIDDEN = /[^A-Za-z0-9!#$%&'*+.^_`|~-]/;
// Delimiter chars only — control chars (CR/LF/NUL/...) are checked separately via
// charCodeAt (below) so no raw control-character range appears in a regex literal.
const COOKIE_VALUE_DELIMITERS_FORBIDDEN = /[\s",;\\]/;

function hasControlCharacter(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

/**
 * The single auditable point where the configured brand cookie is forwarded.
 * Rejects delimiter/control chars (`;`, CR/LF, ...) -> null, so a decoded
 * cookie value can never inject extra `name=value` pairs into the outgoing
 * `Cookie` header.
 */
export function buildCookieHeader(name: string, value: string): string | null {
    if (!name || COOKIE_NAME_FORBIDDEN.test(name)) return null;
    if (!value || COOKIE_VALUE_DELIMITERS_FORBIDDEN.test(value) || hasControlCharacter(value)) return null;
    return `${name}=${value}`;
}

// Code-only auth keys: NEVER overridable via `<SLUG>_BRAND_OVERRIDE`. `kind` is the
// type discriminator; `whoamiAllowedHosts` is the SSRF gate itself;
// `requireVerifiedEmail` is a security policy. Any NEW non-overridable field
// added to BrandAuthConfig MUST be listed here.
const PROTECTED_AUTH_KEYS = new Set(['kind', 'whoamiAllowedHosts', 'requireVerifiedEmail']);
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_COOKIE_NAME_LENGTH = 128;

/**
 * Single call-time read seam for `<SLUG>_BRAND_OVERRIDE`. Returns `null` on
 * absent/malformed/non-object JSON (fail-safe to the registry defaults).
 */
export function readBrandOverride(slug: BrandSlug): Record<string, unknown> | null {
    const envName = `${slug.toUpperCase().replace(/-/g, '_')}_BRAND_OVERRIDE`;
    const raw = process.env[envName]?.trim();
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
}

/**
 * Effective auth = registry auth + `<SLUG>_BRAND_OVERRIDE.auth` (nested JSON).
 * Only string fields already present on the base auth object may be
 * overridden (`whoamiUrl`, `signInUrl`, `signOutUrl`, `sessionCookieName`) —
 * `kind`/`whoamiAllowedHosts` are protected, `responseMapping` is an object
 * (deferred/unsupported), and unknown keys are dropped. Every rejection is
 * logged (`{slug, field}` only — never the attempted value) per the
 * Companion's SA3/D3 divergence from abeduls3 (which does not log).
 */
export function resolveEffectiveAuth(config: CompanionBrandConfig): BrandAuthConfig {
    const { auth, slug } = config;
    const parsed = readBrandOverride(slug);
    if (!parsed) return auth;

    const authOverride = parsed.auth;
    if (typeof authOverride !== 'object' || authOverride === null) return auth;
    const ov = authOverride as Record<string, unknown>;

    const base = auth as unknown as Record<string, unknown>;
    let next: Record<string, unknown> | null = null; // clone lazily; an inert override returns the frozen registry auth
    for (const key of Object.keys(ov)) {
        if (PROTO_KEYS.has(key)) {
            logger.warn({ slug, field: key }, '[brand] override field rejected: prototype-pollution attempt');
            continue;
        }
        if (PROTECTED_AUTH_KEYS.has(key)) {
            logger.warn({ slug, field: key }, '[brand] override field rejected: code-only field (not overridable)');
            continue;
        }
        if (!(key in base)) {
            logger.warn({ slug, field: key }, '[brand] override field rejected: unknown auth field');
            continue;
        }
        const baseVal = base[key];
        const overVal = ov[key];
        if (typeof baseVal !== 'string' || typeof overVal !== 'string') {
            logger.warn({ slug, field: key }, '[brand] override field rejected: type mismatch (string fields only)');
            continue;
        }
        if (key === 'sessionCookieName') {
            if (overVal.length === 0 || overVal.length > MAX_COOKIE_NAME_LENGTH || COOKIE_NAME_FORBIDDEN.test(overVal)) {
                logger.warn({ slug, field: key }, '[brand] override field rejected: invalid session cookie name');
                continue;
            }
        } else {
            try {
                new URL(overVal);
            } catch {
                logger.warn({ slug, field: key }, '[brand] override field rejected: malformed URL');
                continue;
            }
        }
        if (!next) next = { ...base };
        next[key] = overVal;
    }
    return next ? (next as unknown as BrandAuthConfig) : auth;
}

/**
 * Effective session cookie name = registry sessionCookieName +
 * `<SLUG>_BRAND_OVERRIDE.auth.sessionCookieName`. Every reader of "which
 * cookie to pull off the incoming request" MUST resolve the name through
 * here so it agrees with `resolveValidatedWhoamiTarget`'s forwarded name.
 */
export function resolveEffectiveSessionCookieName(config: CompanionBrandConfig): string {
    return resolveEffectiveAuth(config).sessionCookieName;
}

export type ValidatedWhoamiTarget =
    | { ok: true; whoamiUrl: URL; signInUrl: string; signOutUrl?: string; sessionCookieName: string }
    | { ok: false; reason: string };

/**
 * The ONLY safe way to obtain a fetchable whoami target — every consumer
 * (session-resolver, Fase 3) MUST use this, never the raw effective auth, so
 * an off-allowlist override can never reach `fetch`.
 *
 * GENERALIZED vs abeduls3 (`identity.ts:152-159`): the original returns
 * `{ ok: false }` whenever `kind !== 'partner-whoami'`, because in abeduls3's
 * designer app `capsule` is an internal, co-located endpoint with no
 * `whoamiUrl` at all. Here BOTH `BrandAuthConfig` variants carry
 * `whoamiUrl`/`whoamiAllowedHosts` (brand.contract.ts) because the Companion
 * is a standalone service — a `capsule` brand (abe) still needs to forward
 * the cookie to an EXTERNAL whoami endpoint with its own SSRF gate (D5.b).
 * Rejecting by `kind` here would make abe permanently `misconfigured`.
 */
export function resolveValidatedWhoamiTarget(config: CompanionBrandConfig): ValidatedWhoamiTarget {
    const eff = resolveEffectiveAuth(config);
    const v = validateWhoamiUrl(eff.whoamiUrl, eff.whoamiAllowedHosts);
    if (!v.ok) return { ok: false, reason: `whoamiUrl: ${v.reason}` };
    return { ok: true, whoamiUrl: v.url, signInUrl: eff.signInUrl, signOutUrl: eff.signOutUrl, sessionCookieName: eff.sessionCookieName };
}

/** Maps a brand's raw whoami JSON response into the canonical `BrandUser`. */
export function normalizeBrandUser(mapping: BrandResponseMapping, raw: unknown): BrandUser | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const rawId = r[mapping.idField];
    const id = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId : null;
    if (id === null || !PARTNER_ID_PATTERN.test(id)) return null;
    const email = r[mapping.emailField];
    if (typeof email !== 'string' || !email.includes('@')) return null;
    const name = r[mapping.nameField];
    const image = r[mapping.imageField];
    return {
        id,
        email,
        displayName: typeof name === 'string' ? name : null,
        imageUrl: typeof image === 'string' ? image : null,
    };
}
