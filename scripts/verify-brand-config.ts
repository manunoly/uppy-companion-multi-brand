/**
 * Verifies the Companion's brand configuration WITHOUT booting the server.
 *
 * Post-cutover (docs/superpowers/plans/2026-07-02-companion-multibrand-
 * alineacion-abeduls3.md, Task 7.1) a brand's effective config is no longer a
 * `COMPANION_BRANDS` CSV + one big `<SLUG_UPPER_SNAKE>` JSON blob — it's:
 *
 *   1. the code-only base registry (`src/modules/brand/registry.ts`)
 *   2. merged with `<SLUG>_BRAND_OVERRIDE` (auth fields only, allowlisted +
 *      SSRF-gated by `src/modules/brand/identity.ts`)
 *   3. plus per-brand S3/OAuth secrets (`src/lib/secrets.ts#loadBrandSecrets`,
 *      `SECRETS_SOURCE=env` for Railway by default, `aws` for Secrets Manager)
 *
 * This script walks every KNOWN slug (not just servable ones) and prints the
 * resulting effective config, masking/omitting every secret (S3 keys, OAuth
 * client secrets). It deliberately does NOT import `src/config/env.ts` (and
 * so does NOT require `COMPANION_SECRET`/`REDIS_URL` to be set) — the brand
 * registry/identity/secrets modules it exercises have no dependency on the
 * global env schema, so this script can run standalone in any dev shell with
 * just `.env` (or nothing at all) loaded.
 *
 * A brand whose `SECRETS_SOURCE=env` credentials aren't set (the common case
 * for a brand you aren't actively developing against, e.g. running this
 * against a checkout with no `EDO_S3_*` set) is NOT treated as a failure —
 * `loadBrandSecrets` throwing is caught and printed as a clear, per-brand
 * warning. The script only sets a non-zero exit code for issues that would
 * actually be a deploy-blocking bug in a SERVABLE brand: an invalid
 * `BRAND_FORCE`, or a whoami target that fails its own SSRF allowlist check
 * (`whoamiAllowedHosts`) for a brand that IS servable (non-empty
 * `companionHosts`) — the two things that would make edo (or any future
 * servable brand) silently fail at request time with no obvious cause.
 *
 * Usage:
 *   npx tsx scripts/verify-brand-config.ts
 *
 * Run this after editing `<SLUG>_BRAND_OVERRIDE` or any per-brand secret env
 * var (see `.env.example`), and before deploying.
 */

import 'dotenv/config';
import { getAllBrandSlugs, getServableSlugs, getBaseBrandConfig } from '../src/modules/brand/registry.js';
import { resolveEffectiveAuth, resolveValidatedWhoamiTarget } from '../src/modules/brand/identity.js';
import { assertBrandForceIsServable } from '../src/modules/brand/detect.js';
import { loadBrandSecrets, resolveSecretsSource } from '../src/lib/secrets.js';
import type { BrandAuthConfig } from '../src/modules/brand/brand.contract.js';

const maskSecret = (value: string | undefined | null): string => {
    if (!value) return '(not set)';
    if (value.length <= 4) return '****';
    return `****...${value.slice(-4)}`;
};

let hasBlockingIssue = false;

console.log('Verifying Companion brand configuration (base registry + <SLUG>_BRAND_OVERRIDE + secrets)...\n');

// --- Global, brand-independent checks ---

try {
    assertBrandForceIsServable();
    if (process.env.BRAND_FORCE) {
        console.log(`BRAND_FORCE=${process.env.BRAND_FORCE} (every request will be routed to this brand regardless of Host)\n`);
    }
} catch (error) {
    console.error(`BLOCKING: ${(error as Error).message}\n`);
    hasBlockingIssue = true;
}

const secretsSource = resolveSecretsSource(process.env);
console.log(`SECRETS_SOURCE=${secretsSource}`);
console.log(`COMPANION_SECRET: ${process.env.COMPANION_SECRET ? maskSecret(process.env.COMPANION_SECRET) : '(not set — required to actually boot the server; not required by this script)'}\n`);

const servableSlugs = new Set(getServableSlugs());

// --- Per-brand effective config ---

for (const slug of getAllBrandSlugs()) {
    const base = getBaseBrandConfig(slug);
    const isServable = servableSlugs.has(slug);

    console.log(`[Brand: ${slug}] ${base.name}`);
    console.log(`  servable:        ${isServable ? 'yes' : 'no (companionHosts is empty in the registry)'}`);
    console.log(`  companionHosts:  ${base.companionHosts.join(', ') || '(none)'}`);
    console.log(`  domains:         ${base.domains.join(', ') || '(none)'}`);
    console.log(`  companionUrl:    ${base.companionUrl || '(not set)'}`);
    console.log(`  assets.s3Prefix: ${JSON.stringify(base.assets.s3Prefix)}`);
    console.log(`  upload.plugins:  ${base.upload.plugins.join(', ') || '(none)'}`);

    const effectiveAuth: BrandAuthConfig = resolveEffectiveAuth(base);
    const overridden = effectiveAuth !== base.auth;
    const overrideEnvVar = `${slug.toUpperCase().replace(/-/g, '_')}_BRAND_OVERRIDE`;
    console.log(`  auth.kind:              ${effectiveAuth.kind}`);
    console.log(`  auth.signInUrl:         ${effectiveAuth.signInUrl || '(not set)'}`);
    console.log(`  auth.signOutUrl:        ${effectiveAuth.signOutUrl ?? '(not set)'}`);
    console.log(`  auth.sessionCookieName: ${effectiveAuth.sessionCookieName}`);
    console.log(`  ${overrideEnvVar}: ${overridden ? 'applied (one or more auth fields overridden)' : '(not set / no effect)'}`);

    const whoamiTarget = resolveValidatedWhoamiTarget(base);
    if (whoamiTarget.ok) {
        console.log(`  auth.whoamiUrl:  ${whoamiTarget.whoamiUrl.toString()} (passes the whoamiAllowedHosts SSRF gate)`);
    } else if (isServable) {
        console.error(`  auth.whoamiUrl:  BLOCKING — invalid (${whoamiTarget.reason}). This brand is servable — every request would 503 as "misconfigured".`);
        hasBlockingIssue = true;
    } else {
        console.log(`  auth.whoamiUrl:  not configured (${whoamiTarget.reason}) — OK, this brand is not servable yet.`);
    }

    try {
        const secrets = loadBrandSecrets(slug);
        console.log(`  s3.bucket:      ${secrets.s3.bucket}`);
        console.log(`  s3.region:      ${secrets.s3.region}`);
        console.log(`  s3.accessKey:   ${maskSecret(secrets.s3.accessKey)}`);
        console.log(`  s3.secretKey:   ${maskSecret(secrets.s3.secretKey)}`);
        const providerNames = Object.keys(secrets.providers);
        console.log(`  providers:      ${providerNames.length > 0 ? providerNames.join(', ') : '(none configured)'}`);
    } catch (error) {
        const label = isServable ? 'secrets not loaded' : 'secrets not loaded (expected — brand not servable)';
        console.warn(`  ${label}: ${(error as Error).message}`);
    }

    console.log('');
}

if (hasBlockingIssue) {
    console.error('FAILED — one or more servable brands have a blocking configuration issue (see BLOCKING lines above).');
    process.exitCode = 1;
} else {
    console.log('OK — no blocking configuration issues found for servable brands.');
    console.log('(Per-brand secret warnings above, if any, are informational for brands you are not currently configuring.)');
}
