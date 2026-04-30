# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager: **pnpm** (Node.js >= 22).

```bash
pnpm install              # install deps
pnpm dev                  # tsx watch src/index.ts (hot reload)
pnpm build                # tsc -p tsconfig.build.json + node scripts/build-assets.mjs -> dist/ (excludes *.test.ts and src/test-utils/**)
pnpm start                # node dist/index.js (after build)
pnpm typecheck            # tsc --noEmit (uses root tsconfig.json — covers tests too)
pnpm test                 # vitest run (single pass, CI mode)
pnpm test:watch           # vitest in watch mode
pnpm test:coverage        # vitest run --coverage (V8); fails if thresholds drop below 70/60/70/70
```

Verify brand configuration loaded from `.env` (parses `COMPANION_BRANDS` and the per-brand JSON env vars):

```bash
npx tsx scripts/verify-brand-config.ts
```

To run a subset of tests, pass paths or globs as positional args: `pnpm test src/modules/brand` or `pnpm test src/core/cors.test.ts`. There is no linter or formatter wired into `package.json`.

### Test layout

- Unit tests live alongside source as `*.test.ts` and integration tests as `*.integration.test.ts` (same vitest run; the suffix is for human readability only).
- Shared fixtures: `src/test-utils/fixtures.ts` (`makeBrand`, `makeBrandRegistry`, `makeUser`, `makeAppRequest`) and `src/test-utils/env-fixtures.ts` (`makeValidEnv`).
- Integration tests build an Express app via `createTestApp(...)` in `src/test-utils/http.ts`, which uses `assembleApp(...)` from `src/server.ts` with a mocked `@uppy/companion` and an injected env/brand registry. AWS S3 is mocked per test via `aws-sdk-client-mock` (`mockClient(S3Client)`).
- `tsconfig.build.json` extends the root `tsconfig.json` and excludes `**/*.test.ts` and `src/test-utils/**` so they never reach `dist/`. **Never** revert `pnpm build` to use the root `tsconfig.json` — it would emit tests into the production bundle.

## Architecture

A single Express server hosts **one isolated `@uppy/companion` instance per brand**, all mounted under `/{brandId}` paths. Each brand has its own OAuth credentials, S3 bucket, and auth backend. Understanding this layered request flow is the single most important thing when working in this codebase:

```
Request: /:brandId/...
  → server.ts mounts a per-brand chain at literal `/${brand.id}`:
      1. attaches req.brand directly  (NOT via brand.middleware — see "Gotchas")
      2. URL fix-up: strips an unwanted `/default/` segment from OAuth callbacks for non-default brands
      3. attachUser  (modules/auth) — optional, populates req.user if token validates
      4. /uppy + /uppyModal.js routes (modules/companion/uppy.routes)
      5. /api/* — custom S3 signing routes (modules/companion/s3)
      6. companion.app(...) — the actual Uppy Companion instance for OAuth providers
```

### Module map

- `src/index.ts` — entry point, HTTP server lifecycle, attaches Companion WebSocket.
- `src/server.ts` — assembles Express app, builds the brand registry, mounts each brand. **All per-brand mounting lives here**; do not move it to a middleware.
- `src/config/` — `env.ts` derives config, `env.schema.ts` validates with Zod. `secret` must be ≥16 chars.
- `src/modules/brand/` — `brand.service.ts` reads `COMPANION_BRANDS` (CSV), normalizes each slug to `[a-z0-9-]`, then loads its JSON config from the env var named `<SLUG_UPPER_SNAKE>` (e.g. `brand-a` → `BRAND_A`). The first brand in `COMPANION_BRANDS` is the **default brand**.
- `src/modules/companion/companion.factory.ts` — `buildCompanionOptions(brand)` and `createCompanionForBrand(brand)`. Translates the `Brand` shape into Companion's `providerOptions`/`s3` config. Sets `oauthDomain`/`oauthProtocol`/`oauthPath` on every provider from `brand.companionUrl` so OAuth `redirect_uri` works behind proxies.
- `src/modules/companion/uppy.routes.ts` — `serveUppyPage` reads `uppy.html` at runtime and fills placeholders (`BRAND_SLUG_VALUE`, `COMPANION_URL_VALUE`, `FOLDERS_DATA_VALUE`, `ENABLED_PLUGINS_VALUE`, etc.) — **no bearer token is ever injected**. JS literals use `toJsStringLiteral` and inline JSON uses `safeJsonForHtmlScript`; both escape `</`, `<!--`, `-->`, and U+2028/U+2029 to prevent script-tag breakout. The handler also sets `Cache-Control: no-store` because the page contains per-user data. `serveUppyModalJs` serves the precompiled `dist/.../uppyModal.js` (built by `scripts/build-assets.mjs`); in dev it falls back to runtime transpilation via dynamic `import('esbuild')`.
- `src/modules/companion/api.routes.ts` + `s3/s3.controller.ts` — custom S3 multipart endpoints (sign-s3, multipart create/sign part/list/complete/abort) signed with the brand's `S3Client`.
- `src/modules/companion/s3/s3.key-builder.ts` — produces keys like `{brand}/original/{userId}/{YYYY}/{M}/{D}/{timestamp}/{filename}`. **Throws** if `req.user` is missing — `requireAuth` on `/api/uppy/*` is responsible for guaranteeing the invariant. Never silently substitute a default userId here; that breaks attribution and OWASP API1 (BOLA).
- `src/modules/auth/` — `extractToken` priority is **`Authorization: Bearer` header → cookie `brand.auth.cookieName`**. The `?bearerToken=` query param is NOT honored anywhere — auth flows exclusively through the cookie. The cookie is set by the **brand backend** at `Domain=.<rootDomain>` (configured via `brand.rootDomain`), so the browser sends it automatically to all subdomains under the brand root: same-origin to Companion, and cross-origin to `publicUploadUrl` via `credentials: 'include'`. Companion never sets cookies on the brand domain — it only consumes them. When the cookie is missing or invalid on `/uppy`, Companion 302s to `brand.public.loginUrl?redirect=<full url>` (or renders a static 401 page if `loginUrl` is unset). `requireAuth` on `/api/uppy/*` returns 401 in the same scenario for API callers.
- **Per-brand CORS** (`src/core/cors.ts`): `/api/uppy/*` is wrapped in `corsForBrand(brand, env.protocol)` which echoes any matching `*.<rootDomain>` origin with `Access-Control-Allow-Credentials: true`. In production (`env.protocol === 'https'`) only HTTPS origins are echoed — never echo Allow-Credentials to a plain-HTTP origin under the brand root, otherwise a page on `http://anywhere.<rootDomain>` could read credentialed responses (the `Secure` cookie still travels because the request URL is HTTPS). Browser-side, all `/uppy` page fetches use `credentials: 'include'`; no `Authorization: Bearer` header is sent.
- `src/modules/folders/folders.service.ts` — fetches user folder list for the Uppy page from `brand.public.foldersUrl`; failures degrade silently to `[]`.
- `src/lib/aws/s3Client.ts` — builds `S3Client`. If `accessKey`/`secretKey` are absent it falls back to the AWS Default Credential Provider Chain (IAM roles on ECS/Fargate).
- `src/core/types/express.ts` — `AppRequest` extends Express `Request` with `brand?` and `user?`. Most middleware/handlers cast to `AppRequest`.

### Brand resolution & config

A brand's runtime configuration is the merge of three sources, in order of precedence:

1. **JSON in `<SLUG_UPPER_SNAKE>` env var** — full override, see README "Brand Configuration (JSON)" for the schema.
2. **Global `COMPANION_*` / `AWS_*` env vars** — fallback for OAuth credentials, S3 keys, and Google Picker keys.
3. **Hardcoded defaults** — e.g. `auth.cookieName = 'session'`, `uploadUrls = ['*']`.

The legacy flat fields (`authUrl`, `authCookieName`, `publicBackendUrl`, `publicUploadUrl`) on `BrandConfigJSON` are kept for backwards compatibility — prefer the nested `auth.*` and `public.*` blocks.

The `enabledPlugins` field is a **case-insensitive comma-separated string** (e.g. `"Url,GoogleDrivePicker,Dropbox"`) parsed against a fixed allowlist in `brand.service.ts`. Unknown names are silently dropped. If `enabledPlugins` is empty, `uppy.routes.ts:getEnabledPlugins` derives a list from which providers are configured.

### Gotchas

- **Don't use `createBrandMiddleware` for per-brand mounts.** It reads `req.params.brand`, which is empty when mounted on a literal path like `/acme`, so it would fall back to the default brand. `server.ts` instead attaches `req.brand` directly inside the per-brand mount chain. The middleware exists for routes that take `:brand` as a path/query/header parameter.
- **`companionUrl` is the source of truth for OAuth redirect URIs** when behind a proxy. Without it, Companion derives the redirect from `brand.server.{host,protocol,path}` and mis-routes callbacks (often producing the spurious `/default/` segment that the URL-fix middleware in `server.ts` strips).
- **Trust proxy is on (`app.set('trust proxy', 1)`)** and sessions use `secure`/`sameSite=none` cookies when `COMPANION_PROTOCOL=https`. Required for Railway/AWS/Heroku-style proxied HTTPS.
- **Browser assets are built via `scripts/build-assets.mjs`** (run as part of `pnpm build`). It transpiles `src/modules/companion/uppyModal.ts` → `dist/modules/companion/uppyModal.js` (browser ESM, target es2020) and copies `uppy.html` alongside it. `tsc` also emits a Node-flavored `uppyModal.js` for the same source — the build script's esbuild output overwrites it. Don't import `uppyModal.ts` from server code; treat it as a browser module that lives in the same directory as a convenience.
- **`serveUppyModalJs` prefers the precompiled `uppyModal.js`** (prod) and serves it via `res.sendFile` with `Cache-Control: public, max-age=300`. If the file is missing (dev mode), it falls back to in-process transpilation via a dynamic `import('esbuild')`, memoized by source content. **Do not move `esbuild` back into `dependencies`** — it's a devDependency; the prod path never imports it.
- **Brand JSON parse failures fall through silently** (logged, then treated as empty config, so the brand is created with all-default values). Run `verify-brand-config.ts` after editing a brand's JSON env var.
- TypeScript is configured for **NodeNext ESM** with strict mode and `noUnusedLocals`/`noUnusedParameters` enabled. Internal imports must include the `.js` extension (e.g. `from './brand.service.js'`) even though the source file is `.ts`.

### Key environment variables

Required: `COMPANION_SECRET` (≥16 chars), `COMPANION_BRANDS` (CSV of slugs). See `.env.example` for the full list of OAuth provider globals and the JSON brand-config template. `HEALTH_CHECK_KEY` gates the detailed view at `GET /api/brands?key=...` (basic view shows only `id`/`displayName`, detailed view masks all secrets to `****...last4`).
