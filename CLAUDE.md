# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager: **pnpm** (Node.js >= 22).

```bash
pnpm install              # install deps
pnpm dev                  # tsx watch src/index.ts (hot reload)
pnpm build                # tsc -p tsconfig.build.json + node scripts/build-assets.mjs -> dist/ (excludes *.test.ts and src/test-utils/**)
pnpm start                # node dist/index.js (after build)
pnpm typecheck            # tsc --noEmit (uses root tsconfig.json — covers src/** including tests; scripts/ is NOT included)
pnpm test                 # vitest run (single pass, CI mode)
pnpm test:watch           # vitest in watch mode
pnpm test:coverage        # vitest run --coverage (V8); fails if thresholds drop below 70/60/70/70
pnpm lint                 # biome check . (formatter + assist disabled — lint rules only)
pnpm format               # biome format --write .
```

CI (`.github/workflows/ci.yml`) runs, in order, on every push/PR: `pnpm lint` → `pnpm typecheck` → `pnpm build` → `pnpm test:coverage`. All four are gates — `pnpm build` in particular catches anything `tsc --noEmit` alone would miss (e.g. `tsconfig.build.json`'s narrower `include`). Dependabot, CodeQL, and gitleaks also run as separate workflows.

Verify a brand's effective configuration (base registry + `<SLUG>_BRAND_OVERRIDE` + per-brand secrets), without booting the server:

```bash
npx tsx scripts/verify-brand-config.ts
```

To run a subset of tests, pass paths or globs as positional args: `pnpm test src/modules/brand` or `pnpm test src/core/cors.test.ts`.

### Test layout

- Unit tests live alongside source as `*.test.ts` and integration tests as `*.integration.test.ts` (same vitest run; the suffix is for human readability only).
- Shared fixtures: `src/test-utils/fixtures.ts` (`makeBrand`, `makeBrandRegistry`, `makeUser`, `makeAppRequest` — built against the current `Brand`/`BrandUser` contract, `brand.contract.ts`) and `src/test-utils/env-fixtures.ts` (`makeValidEnv`).
- Integration tests build an Express app via `createTestApp(...)` in `src/test-utils/http.ts`, which uses `assembleApp(...)` from `src/server.ts` with a mocked `@uppy/companion` and an injected env/brand registry. AWS S3 is mocked per test via `aws-sdk-client-mock` (`mockClient(S3Client)`); Redis is mocked per test via `vi.mock('ioredis', ...)` swapping in `ioredis-mock` (see `src/lib/redis.test.ts`, `whoami-breaker.test.ts`, `session-resolver.test.ts` for the pattern) — there is no global Redis mock wired into `vitest.config.ts`, each test file that touches `getRedis()` mocks it itself.
- `tsconfig.build.json` extends the root `tsconfig.json` and excludes `**/*.test.ts` and `src/test-utils/**` so they never reach `dist/`. **Never** revert `pnpm build` to use the root `tsconfig.json` — it would emit tests into the production bundle.
- `scripts/**` is excluded from both the coverage `include` (`vitest.config.ts`) and effectively untyped by `pnpm typecheck` (root `tsconfig.json`'s `include` is `src/**/*` only) — `npx tsx` transpiles scripts without type-checking them. Keep them correct by inspection/manual runs, not by relying on `tsc`.

## Architecture

A single Express server hosts **one isolated `@uppy/companion` instance per brand**. Brands are resolved by the inbound **`Host` header** (exact-match against each brand's `companionHosts`), not by URL path — there is no `/{brandId}/...` mount anymore. Each brand has its own OAuth credentials, S3 bucket, and partner auth endpoint. Understanding this request flow (`src/server.ts#assembleApp`, in middleware order) is the single most important thing when working in this codebase:

```
Request: Host: <brand's companionHost>
  1. pino-http request logging + AsyncLocalStorage context (requestId)         — lib/logger.ts
  2. express.json / urlencoded / cookieParser
  3. per-request CSP nonce (res.locals.cspNonce) + helmet                      — core/csp.ts (per-brand directives)
  4. GLOBAL per-IP rate limiter (Redis-backed)                                 — bounds every route below, incl. attachUser's whoami-fetch cost
  5. /api/healthz (liveness) and /api/readyz (Redis PING + S3 HeadBucket)      — exempt from the global limiter
  6. /api/brands (masked list; ?key=HEALTH_CHECK_KEY unlocks the detailed view)
  7. Host-based brand resolution: resolveBrandByHost(Host) -> req.brand, else 404 "Unknown host"
  8. express-session (Redis-backed via connect-redis; Companion's own OAuth handshake state — unrelated to the brand's partner session cookie)
  9. attachUser  (modules/auth) — populates req.user via resolveSession(); NEVER rejects
  10. per-brand+user rate limiter, mounted only on /uppy and /api/*
  11. /uppy + /uppyModal.js routes                                             — modules/companion/uppy.routes
  12. per-brand CORS wrapper + /api/* custom S3 signing routes                 — core/cors.ts, modules/companion/s3
  13. requireAuth on /s3 (Companion's built-in S3 endpoints — its getKey callback throws without req.user)
  14. companion.app(...) for the resolved brand                               — the actual Uppy Companion instance (OAuth providers, etc.)
```

### Module map

- `src/index.ts` — entry point. Boots via `createServer()`, attaches the Companion WebSocket, and handles graceful shutdown on `SIGTERM`/`SIGINT`: flips readiness/liveness to 503 immediately, `server.close()`, `closeRedis()`, force-exits after a 10s safety timer (long-lived WS connections aren't tracked by `server.close()`'s drain).
- `src/server.ts` — `assembleApp(...)` builds the Express app from an already-resolved `brandRegistry`/`companionInstances` (fully unit-testable without real env/secrets); `createServer()` is the real bootstrap (calls `assertBrandForceIsServable()`, `createBrandRegistry()`, then `assembleApp`). Also defines the Redis-backed session store/options, the two rate limiters (global per-IP and per-brand+user), and the readiness checks (`checkRedis`/`checkS3`).
- `src/config/` — `env.schema.ts` (Zod) + `env.ts` (`deriveEnv()`) validate only **brand-independent, global** server config (`port`, `host`, `protocol`, `publicHost`, `secret` ≥16 chars, `healthCheckKey`, `redisUrl`, `secretsSource`, `filePath`, `rateLimit*`). Brand config is NOT derived here — see `modules/brand/` below.
- `src/modules/brand/`
  - `slugs.ts` — `BrandSlug` = `'abe' | 'picaboo' | 'edo'`, `isBrandSlug`, `BRAND_SLUG_VALUES`. Ported 1:1 from abeduls3's `@package/brands`.
  - `brand.contract.ts` — the brand type contract: `BrandAuthConfig` (discriminated union `capsule | partner-whoami`, both variants carry `whoamiUrl`/`whoamiAllowedHosts` since the Companion is standalone — see identity.ts), `CompanionBrandConfig`, `Brand` (`CompanionBrandConfig` + an initialized `S3Client`), `BrandUser` (`id`/`email`/`displayName`/`imageUrl` + optional `edoId`).
  - `registry.ts` — the code-only, deep-frozen **base registry**, one entry per known slug. `getServableSlugs()` returns only slugs with a non-empty `companionHosts` (today: just `edo`; `abe`/`picaboo` are registered but not servable — no external whoami endpoint confirmed yet, see the registry's own comments).
  - `identity.ts` — `readBrandOverride(slug)` reads/parses `<SLUG>_BRAND_OVERRIDE`; `resolveEffectiveAuth(config)` merges it over the base `auth` (allowlisted **string fields only**: `whoamiUrl`, `signInUrl`, `signOutUrl`, `sessionCookieName` — everything else, including `kind` and `whoamiAllowedHosts`, is code-only and logged+dropped if present in an override); `resolveValidatedWhoamiTarget(config)` is the **only** safe way to get a fetchable whoami URL (SSRF gate: https, no credentials/non-default port, host matched against `whoamiAllowedHosts` by suffix, `h === e || h.endsWith('.'+e)`); `buildCookieHeader(name, value)` is the single point where a forwarded `Cookie:` header is built (rejects delimiter/control chars -> `null`); `normalizeBrandUser(mapping, raw)` maps a whoami JSON response into `BrandUser`.
  - `detect.ts` — `resolveBrandByHost(host)`: `BRAND_FORCE` always wins; otherwise exact-match the normalized `Host` against every servable brand's `companionHosts`; unknown host -> `null` (404), **never** falls back to a default brand. `assertBrandForceIsServable()` is a boot-time guard (throws if `BRAND_FORCE` names an unknown or non-servable slug).
  - `brand.schema.ts` — Zod structural schemas (`companionBrandConfigSchema`, `brandOverrideSchema`, `companionProvidersSchema`, ...). These give fast feedback on gross shape errors; they are **not** the enforcement point for the override allowlist/SSRF gate — `identity.ts` is.
  - `brand.service.ts` — `resolveBrand(slug)` / `createBrandRegistry()`: base registry -> `resolveEffectiveAuth` override -> `loadBrandSecrets` (S3 creds + OAuth secrets) -> fully-formed `Brand` with an initialized `S3Client`. Only servable slugs are resolved.
  - `brand.types.ts` — now just `export * from './brand.contract.js'`, kept so existing `from '.../brand.types.js'` imports don't need touching everywhere.
  - `brand.middleware.ts` — `createBrandMiddleware`/`requireBrand`, for routes that take `:brand` as an explicit path/query/header param. **Not** used for the Host-based resolution above (see Gotchas).
- `src/modules/auth/`
  - `session-resolver.ts` — `resolveSession(brand, cookieHeader)`, the hardened `partner-whoami` flow. **Order is a security property** (mirrors abeduls3's `resolvePartnerSocketIdentity.ts`): extract the named cookie's value -> `resolveValidatedWhoamiTarget` (SSRF gate; `misconfigured` never reaches `fetch`) -> `buildCookieHeader` (a malformed value is `unauthenticated` and must precede the breaker check, or an unauthenticated caller could open the breaker for every user of the brand) -> circuit breaker `isOpen` check -> Redis cache read (`companion-whoami:{slug}:{sha256(cookie)}`, 45s TTL, full serialized `BrandUser`) -> `fetch(whoamiUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) })` -> status interpretation (any redirect form, `status===0`, or non-401 `!ok` -> `unavailable` + `recordFailure`; `401` -> `unauthenticated` + `recordSuccess`) -> 16KB streaming body cap -> `normalizeBrandUser` -> (`slug==='edo'` only) `enrichEdoUser`.
  - `whoami-breaker.ts` — Redis-backed circuit breaker (NOT a port — abeduls3's equivalents are in-memory, which doesn't work across the Companion's >=2 replicas with no sticky sessions). 3 failures (`INCR`) opens it for 30s; `recordSuccess` clears everything; after the cooldown, exactly one caller across all replicas is granted a half-open probe (`SET NX EX`).
  - `enrich-edo.ts` — `enrichEdoUser(user, raw)`, edo-only (gated by `slug==='edo'` in `session-resolver.ts`, not by `auth.kind`): reads `raw.edo_id` -> `user.edoId` (metadata/listing only — **never** used for S3 keys, see SA1) and normalizes an edo `"<username>::<realEmail>"` email prefix.
  - `auth.middleware.ts` — `attachUser` populates `req.user` from `resolveSession`, never rejects (an `unavailable` result just logs a warning and leaves `req.user` unset). `requireAuth` turns "no user" into 401 (unauthenticated)/503 (`unavailable` — partner whoami down)/403 (`misconfigured` — invalid brand auth config).
- `src/modules/companion/`
  - `companion.factory.ts` — `buildCompanionOptions(brand, env)`/`createCompanionForBrand(brand, env)`. `allowLocalUrls: env.protocol === 'http'` (dev only); `uploadUrls` and `server.validHosts` are **derived** from `companionUrl`/`companionHosts`/`s3.bucket` (never `['*']` — SSRF hardening, D9); OAuth providers are wired only for the plugins listed in `brand.upload.plugins` (`PLUGIN_PROVIDER_KEY`), not merely from which credentials happen to be present.
  - `uppy.routes.ts` — `serveUppyPage` uses `req.user` already populated by `attachUser` upstream — it does **not** re-validate the session itself (no double-auth). Fills `uppy.html` placeholders via `toJsStringLiteral`/`safeJsonForHtmlScript` (both escape `</`, `<!--`, `-->`, U+2028/U+2029) and injects the per-request CSP nonce (`res.locals.cspNonce`) into the page's inline `<script type="module">`. `serveUppyModalJs` serves the precompiled `dist/.../uppyModal.js` in prod, falling back to an in-process `esbuild` transpile in dev.
  - `api.routes.ts` + `s3/s3.controller.ts` — custom S3 multipart endpoints (sign-s3, multipart create/sign part/list/complete/abort), signed with the brand's `S3Client`; validates declared `Content-Length`/`Content-Type` against `brand.limits` and that a client-supplied key belongs to the caller (`sendIfKeyNotOwned`).
  - `s3/s3.key-builder.ts` — **one function, never branching on brand**: `buildS3Key` = `{brand.assets.s3Prefix}original/{user.id}/{YYYY}/{M}/{D}/{timestamp}/{filename}`. Throws if `req.brand`/`req.user.id` is missing (`requireAuth` on `/api/uppy/*` guarantees the invariant). `edoId` is **never** used here — see SA1 below.
- `src/modules/folders/folders.service.ts` — `fetchFolders(token, brand)` reads `brand.public?.foldersUrl` (optional); missing URL, non-ok response, or any exception all degrade silently to `[]` with a `logger.warn` (SA3 — kept for future Dropbox/GoogleDrivePicker use even though today's brands don't call it from the designer).
- `src/lib/`
  - `logger.ts` — Pino + `AsyncLocalStorage` (`runWithContext`/`getContext`/`setUserId`); `httpLogger` (pino-http) assigns `req.id` from `x-request-id` or a fresh UUID. Silenced under Vitest by default.
  - `redis.ts` — `getRedis()`/`closeRedis()`, a lazily-created singleton `ioredis` client against `env.redisUrl` (Railway's Redis plugin in prod).
  - `secrets.ts` — `loadBrandSecrets(slug)`: `SECRETS_SOURCE=env` (default, Railway service variables, fully synchronous) or `=aws` (AWS Secrets Manager, one JSON secret per brand, cache warmed once at boot via a top-level `await`, `@aws-sdk/client-secrets-manager` loaded via dynamic `import()` so Railway deployments never pull it in). Fails fast (throws) if a servable brand ends up without a usable S3 bucket/region, or — under `env` only — without S3 credentials (Railway has no instance IAM role to fall back to).
  - `aws/s3Client.ts` — `getS3Client(...)`. Falls back to the AWS Default Credential Provider Chain only when access/secret key are absent — relevant for `SECRETS_SOURCE=aws`/real AWS infra, **not** for Railway (D8).
- `src/core/`
  - `cors.ts` — `corsForBrand(brand, envProtocol)`. The trusted apex is `brand.auth.whoamiAllowedHosts[0]` (the abeduls3-aligned contract has no standalone `rootDomain` field — `whoamiAllowedHosts` already holds the bare registrable domain the brand's cookie is scoped to). Echoes any `https://<...>.<apex>` origin (1+ subdomain levels) with `Allow-Credentials: true`; HTTPS-only in production (`envProtocol==='https'`), also allows `http://localhost` in dev.
  - `csp.ts` — `buildConnectSrc`/`buildFrameAncestors`/`buildFrameSrc`/`buildImgSrc`, pure functions of `Brand | undefined` wired into `helmet`'s CSP directives in `server.ts`. Cover the direct-to-S3 XHR/fetch PUT, the designer `<iframe>` embed, Uppy's `blob:` thumbnail previews, and Google Picker origins (only when a brand's `upload.plugins` includes a Google picker variant).
  - `types/express.ts` — `AppRequest` extends Express `Request` with `brand?: Brand` and `user?: BrandUser`.

### Brand resolution & config

A brand's runtime configuration is the merge of three layers, resolved once per brand at boot by `createBrandRegistry()` (`brand.service.ts`):

1. **Code-only base registry** (`src/modules/brand/registry.ts`) — one deep-frozen `CompanionBrandConfig` per known slug (`abe`, `picaboo`, `edo`). Includes `companionHosts` (resolution-by-Host allowlist), `assets.s3Prefix`, `whoamiAllowedHosts` — all **never** overridable.
2. **`<SLUG>_BRAND_OVERRIDE`** env var (JSON) — merged in by `identity.ts#resolveEffectiveAuth`. Only the **string fields of `auth`** may be overridden: `whoamiUrl`, `signInUrl`, `signOutUrl`, `sessionCookieName`. Every rejected field (protected key, prototype-pollution attempt, wrong type, invalid URL/cookie-name shape) is logged via `logger.warn({slug, field})` and silently dropped — the brand falls back to the base value for that field, never throws.
3. **Per-brand secrets** (`src/lib/secrets.ts#loadBrandSecrets`) — S3 credentials + OAuth provider keys, selected by `SECRETS_SOURCE` (`env` = Railway service variables, default; `aws` = one JSON secret per brand in Secrets Manager). Never part of the override — secrets are always out-of-band.

A brand is **servable** only if its base registry entry has a non-empty `companionHosts` (today: just `edo`). `getServableSlugs()` is what `createBrandRegistry()`/`resolveBrandByHost()` both key off of — a non-servable brand gets no Companion instance, no secrets loaded, and can never be resolved by Host. `BRAND_FORCE=<slug>` overrides Host-based resolution entirely (routes every request to that brand) but must itself name a servable slug — `assertBrandForceIsServable()` throws at boot otherwise.

There is no `COMPANION_BRANDS` CSV and no "default brand" concept anymore (D4) — an unresolved Host is a 404, full stop.

### Key environment variables

Required: `COMPANION_SECRET` (≥16 chars, shared across every brand), `PUBLIC_HOST`-equivalent (`COMPANION_HOST`/`publicHost`, has a `localhost:<port>` default). `REDIS_URL` defaults to a local dev instance; in production it's provided by Railway's Redis plugin. `SECRETS_SOURCE` (`env` default / `aws`), `BRAND_FORCE`, `<SLUG>_BRAND_OVERRIDE`, the full per-brand secret variable scheme (`<PREFIX>_S3_*`, `<PREFIX>_<PROVIDER>_KEY`/`_SECRET`, `<PREFIX>_GOOGLE_*`), and `RATE_LIMIT_*`/`RATE_LIMIT_GLOBAL_*` are all documented in `.env.example`. `HEALTH_CHECK_KEY` gates the detailed view at `GET /api/brands?key=...` (basic view shows only `id`/`displayName`, detailed view masks all secrets to `****...last4`).

### Gotchas

- **Don't use `createBrandMiddleware` for the primary Host-based resolution.** `server.ts` calls `resolveBrandByHost(req.headers.host)` directly and attaches `req.brand` itself; `createBrandMiddleware` (`brand.middleware.ts`) reads `req.params.brand`/query/header and exists only for routes that take an explicit `:brand` identifier — there is no "default brand" for it to fall back to (D4 retired that concept), so an unresolved identifier there just leaves `req.brand` unset.
- **`companionUrl` is the source of truth for OAuth redirect URIs.** It's also what `companion.factory.ts` derives `server.validHosts`/`uploadUrls` from (never `['*']` — SSRF hardening). The old `/default/` URL-fix-up hack is fully gone: since Fase 5.1 there is no per-brand path mount to mis-derive a `/default/` segment from in the first place.
- **`<SLUG>_BRAND_OVERRIDE` can only touch `auth`'s string fields.** `kind`, `whoamiAllowedHosts`, `assets.s3Prefix`, `companionHosts`, `s3`, and `providers` are code-only and silently dropped (with a `logger.warn`) if present in an override — this is a deliberate SSRF/tenant-isolation boundary, not an oversight. A malformed/non-JSON override fails **silently** to the base config with **no** log (unlike a rejected individual field within an otherwise-valid override, which IS logged) — run `verify-brand-config.ts` after editing one.
- **A non-servable brand (`companionHosts: []`, e.g. `abe`/`picaboo` today) never gets a Companion instance, secrets, or a route.** Don't invent a `whoamiUrl` for one to "make it work" — see the registry's own comments for why (no confirmed external endpoint). Setting `BRAND_FORCE` to one throws at boot (`assertBrandForceIsServable`).
- **The circuit breaker (`whoami-breaker.ts`) and whoami cache are Redis-backed, not in-memory** — unlike abeduls3's equivalents — because the Companion runs multiple replicas with no sticky sessions. The step order in `session-resolver.ts` (cookie-header validity check BEFORE the breaker check) is a security property: reversing it would let an unauthenticated caller open the breaker for every user of a brand just by spamming malformed cookies.
- **Trust proxy is on (`app.set('trust proxy', 1)`)** and the (Companion-only, OAuth-handshake) session cookie uses `secure`/`sameSite=none` when `COMPANION_PROTOCOL=https`. Required for Railway-style proxied HTTPS. Its name is the single static `companion.sid` and `cookie.path` is `/` — brand isolation now comes from each brand having a distinct `companionHost`, not from a per-brand cookie path/name.
- **Browser assets are built via `scripts/build-assets.mjs`** (run as part of `pnpm build`). It transpiles `src/modules/companion/uppyModal.ts` → `dist/modules/companion/uppyModal.js` (browser ESM, target es2020) and copies `uppy.html` alongside it. `tsc` also emits a Node-flavored `uppyModal.js` for the same source — the build script's esbuild output overwrites it. Don't import `uppyModal.ts` from server code; treat it as a browser module that lives in the same directory as a convenience.
- **`serveUppyModalJs` prefers the precompiled `uppyModal.js`** (prod) and serves it via `res.sendFile` with `Cache-Control: public, max-age=300`. If the file is missing (dev mode), it falls back to in-process transpilation via a dynamic `import('esbuild')`, memoized by source content. **Do not move `esbuild` back into `dependencies`** — it's a devDependency; the prod path never imports it.
- **`SECRETS_SOURCE=aws` warms its cache via a top-level `await` in `src/lib/secrets.ts`**, which Node's ESM loader guarantees settles before any module that transitively imports it (`brand.service.ts` -> `server.ts` -> `index.ts`) finishes evaluating. Don't move `loadBrandSecrets`'s call sites onto an async path expecting to `await` it directly — it's intentionally synchronous.
- TypeScript is configured for **NodeNext ESM** with strict mode and `noUnusedLocals`/`noUnusedParameters` enabled. Internal imports must include the `.js` extension (e.g. `from './brand.service.js'`) even though the source file is `.ts`. `scripts/*.ts` follow the same convention (imported via relative `.js`-suffixed paths into `../src/...`) even though `scripts/` itself isn't covered by `pnpm typecheck`.
