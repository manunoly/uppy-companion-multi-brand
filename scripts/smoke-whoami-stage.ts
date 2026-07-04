/**
 * MANUAL smoke test — validates the REAL edo whoami flow against STAGE.
 *
 * docs/superpowers/plans/2026-07-02-companion-multibrand-alineacion-abeduls3.md,
 * Task 7.2. This is a one-off operator gate, NOT part of `pnpm test`/CI — it
 * makes a real network call to edonext's stage API with a real user's session
 * cookie, and its whole purpose is to get sign-off from the edo/infra team
 * BEFORE the Companion writes to the shared `entourage-uploads` S3 bucket.
 *
 * DO NOT RUN THIS UNATTENDED / IN CI. Do not commit the cookie value you use
 * with it (it is a live stage session credential).
 *
 * -----------------------------------------------------------------------
 * What this confirms (spec §2, "SA" = supuesto a confirmar externamente):
 * -----------------------------------------------------------------------
 *   - SA2 (DNS/TLS): the fetch to `edonext-app.stage.entourageyearbooks.com`
 *     must actually connect and answer over HTTPS.
 *   - SA4 (cross-apex cookie): the cookie you capture from a browser session
 *     under `*.entourageyearbooks.com` must be ACCEPTED when forwarded
 *     server-to-server by the Companion (proves `Domain=.entourageyearbooks.com`
 *     + `Secure` is really how edonext issues it, per ADR-014).
 *   - SA1 (identity/key scheme): the whoami response must contain a canonical
 *     `id` (this script fails loudly if it's missing/empty), and this script
 *     prints the exact S3 key the Companion's key-builder would generate for
 *     that id (`original/{id}/...`, see `src/modules/companion/s3/
 *     s3.key-builder.ts`) — hand that key + the `entourage-uploads` bucket to
 *     the edonext team and have them confirm their pipeline registers/
 *     consumes photos by the KEY THE UPLOAD NOTIFIES (`publicUploadUrl`), not
 *     by assuming a rigid path convention. This script cannot confirm that
 *     part by itself — it only proves the Companion computes A key
 *     consistently from a real edo session.
 *
 * This script does NOT confirm: that the bucket/IAM policy actually accepts a
 * PUT to that key (no S3 call is made here — see `pnpm dev` + a real Uppy
 * upload for that), or that edonext's ingestion pipeline picks the file up.
 *
 * -----------------------------------------------------------------------
 * How to get a stage session cookie:
 * -----------------------------------------------------------------------
 *   1. Log into the edo dashboard at the STAGE origin in a browser, e.g.
 *      https://edonext.stage.entourageyearbooks.com/login (ask the edo team
 *      for a stage test account if you don't have one).
 *   2. Open DevTools -> Application/Storage -> Cookies for
 *      `edonext-app.stage.entourageyearbooks.com` (or whichever origin sets
 *      the session cookie there) and copy the cookie NAME and VALUE. The
 *      name is whatever `sessionCookieName` stage uses (see step 3) — the
 *      base registry's default is `auth_session`, stage may override it
 *      (e.g. `auth_session_stage`), confirm with the edo team.
 *   3. This script resolves the "edo-stage" brand the SAME way the running
 *      server would: base registry (`registry.ts`) + `EDO_BRAND_OVERRIDE`
 *      (`identity.ts`) — it does NOT hardcode the stage whoami URL. Set
 *      `EDO_BRAND_OVERRIDE` to point at stage before running this, e.g.:
 *
 *        export EDO_BRAND_OVERRIDE='{"auth":{"whoamiUrl":"https://edonext-app.stage.entourageyearbooks.com/api/user","signInUrl":"https://edonext.stage.entourageyearbooks.com/login","sessionCookieName":"auth_session_stage"}}'
 *
 *      (Same JSON shape documented in `.env.example` — use the SAME value
 *      designer/node-socket use for stage, per the spec's operational
 *      requirement that every service agree on one override.)
 *   4. Set `EDO_SMOKE_TEST_COOKIE` to the raw `name=value` pair you copied,
 *      matching whatever `sessionCookieName` you set in step 3, e.g.:
 *
 *        export EDO_SMOKE_TEST_COOKIE='auth_session_stage=<paste-the-real-value-here>'
 *
 * -----------------------------------------------------------------------
 * Prerequisites (same runtime dependencies `resolveSession` has in prod):
 * -----------------------------------------------------------------------
 *   - `COMPANION_SECRET` set to ANY value >=16 chars (it is never sent to
 *     edo — it only satisfies the global env schema that `lib/redis.ts`
 *     transitively depends on).
 *   - A reachable Redis at `REDIS_URL` (defaults to `redis://localhost:6379`)
 *     — `resolveSession` uses the same Redis-backed whoami cache + circuit
 *     breaker as production (`src/modules/auth/session-resolver.ts`,
 *     `whoami-breaker.ts`). A local `docker run -p 6379:6379 redis` is fine.
 *
 * -----------------------------------------------------------------------
 * Usage:
 * -----------------------------------------------------------------------
 *   EDO_BRAND_OVERRIDE='...' EDO_SMOKE_TEST_COOKIE='auth_session_stage=...' \
 *     npx tsx scripts/smoke-whoami-stage.ts
 *
 * Exit code 0 only on a fully successful `authenticated` result with a
 * non-empty canonical `user.id`; non-zero otherwise (see the per-status
 * branches below for what each failure means and how to unblock it).
 */

import 'dotenv/config';

const EXPECTED_STAGE_WHOAMI_HOST = 'edonext-app.stage.entourageyearbooks.com';

async function main(): Promise<void> {
    const cookieHeader = process.env.EDO_SMOKE_TEST_COOKIE;
    if (!cookieHeader) {
        console.error('Missing EDO_SMOKE_TEST_COOKIE — see this file\'s header comment for how to obtain a stage session cookie.');
        process.exitCode = 1;
        return;
    }

    if (!process.env.EDO_BRAND_OVERRIDE) {
        console.warn(
            'EDO_BRAND_OVERRIDE is not set — this run will hit the PRODUCTION edo whoamiUrl from the base ' +
                'registry (registry.ts), not stage. Set EDO_BRAND_OVERRIDE to point at ' +
                `${EXPECTED_STAGE_WHOAMI_HOST} first (see header comment) unless that is genuinely what you intend.`,
        );
    }

    // Dynamic imports (not static top-level imports) so a missing prerequisite
    // (COMPANION_SECRET / unreachable Redis) surfaces as the friendly message
    // below instead of a raw stack trace from module-load-time env validation.
    let authModule: typeof import('../src/modules/auth/session-resolver.js');
    try {
        authModule = await import('../src/modules/auth/session-resolver.js');
    } catch (error) {
        console.error('Failed to load the Companion auth runtime. This script needs the same prerequisites as the server:');
        console.error('  - COMPANION_SECRET set to any value >=16 chars (not sent to edo; only satisfies env validation)');
        console.error('  - REDIS_URL reachable (defaults to redis://localhost:6379) — resolveSession shares prod\'s cache/breaker');
        console.error(String(error));
        process.exitCode = 1;
        return;
    }
    const { resolveSession } = authModule;

    const { getBaseBrandConfig } = await import('../src/modules/brand/registry.js');
    const { resolveEffectiveAuth, resolveValidatedWhoamiTarget } = await import('../src/modules/brand/identity.js');
    const { buildUserKeyPrefix } = await import('../src/modules/companion/s3/s3.key-builder.js');

    const base = getBaseBrandConfig('edo');
    const auth = resolveEffectiveAuth(base);
    // Same shape `resolveBrand` (brand.service.ts) produces, minus secrets —
    // resolveSession/buildUserKeyPrefix never touch brand.s3/brand.providers,
    // so the base registry's placeholder bucket/region is fine here.
    const brand = { ...base, auth };

    const target = resolveValidatedWhoamiTarget(brand);
    if (!target.ok) {
        console.error(`whoami target failed the SSRF allowlist check: ${target.reason}`);
        console.error('Check EDO_BRAND_OVERRIDE.auth.whoamiUrl against registry.ts\'s whoamiAllowedHosts for edo.');
        process.exitCode = 1;
        return;
    }

    console.log(`Resolved whoami target: ${target.whoamiUrl.toString()}`);
    if (target.whoamiUrl.hostname !== EXPECTED_STAGE_WHOAMI_HOST) {
        console.warn(
            `Expected host "${EXPECTED_STAGE_WHOAMI_HOST}" (SA2) but resolved to "${target.whoamiUrl.hostname}" — ` +
                'this is fine if you intentionally pointed this at a different environment, otherwise fix EDO_BRAND_OVERRIDE.',
        );
    }

    console.log('Calling resolveSession() with the provided cookie...\n');
    const result = await resolveSession(brand, cookieHeader);

    switch (result.status) {
        case 'authenticated': {
            const { user } = result;
            console.log('AUTHENTICATED');
            console.log(`  user.id (canonical): ${user.id || '(EMPTY)'}`);
            console.log(`  user.edoId (extra):  ${user.edoId ?? '(not present in whoami response)'}`);
            console.log(`  user.email:          ${user.email}`);
            console.log(`  user.displayName:    ${user.displayName ?? '(none)'}`);

            if (!user.id) {
                console.error('\nSA1 FAILED: the canonical user.id is empty — the real key-builder would throw (401) for this user.');
                process.exitCode = 1;
                return;
            }

            const prefix = buildUserKeyPrefix(brand, user);
            const now = new Date();
            const exampleKey = `${prefix}${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}/<timestamp>/<filename>`;

            console.log('\nS3 key the Companion would generate for this user (share with the edonext team — SA1):');
            console.log(`  bucket: ${base.s3.bucket}`);
            console.log(`  key:    ${exampleKey}`);
            console.log(
                '\nSA2 (DNS/TLS) and SA4 (cross-apex cookie) are confirmed by this run reaching AUTHENTICATED at all: ' +
                    'the stage host resolved/answered over HTTPS, and the forwarded cookie was accepted. SA1 still needs ' +
                    'the edonext team to confirm their ingestion registers/consumes photos by the KEY THE UPLOAD NOTIFIES ' +
                    '(publicUploadUrl), not by assuming this path convention — this script cannot confirm that half by itself.',
            );
            process.exitCode = 0;
            return;
        }
        case 'unauthenticated':
            console.error(
                'UNAUTHENTICATED — whoami returned 401, or the cookie was rejected before the request was even sent ' +
                    '(malformed/expired). Get a fresh cookie (see header comment) and retry.',
            );
            process.exitCode = 1;
            return;
        case 'unavailable':
            console.error(
                `UNAVAILABLE — ${result.reason}. Either the circuit breaker is open (wait ~30s and retry), the ` +
                    'endpoint timed out/5xx\'d, or the response body was malformed/too large (>16KB). This does NOT by ' +
                    'itself rule out an SA2 (DNS/TLS) problem — if it persists, check reachability manually ' +
                    `(e.g. curl -vI https://${EXPECTED_STAGE_WHOAMI_HOST}/).`,
            );
            process.exitCode = 1;
            return;
        case 'misconfigured':
            console.error(`MISCONFIGURED — ${result.reason}. Check EDO_BRAND_OVERRIDE and registry.ts's whoamiAllowedHosts for edo.`);
            process.exitCode = 1;
            return;
    }
}

main().catch((error) => {
    console.error('Unexpected error running the stage smoke test:', error);
    process.exitCode = 1;
});
