# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager: **pnpm** (Node.js >= 22).

```bash
pnpm install              # install deps
pnpm dev                  # tsx watch src/index.ts (hot reload)
pnpm build                # tsc -p tsconfig.json -> dist/
pnpm start                # node dist/index.js (after build)
pnpm typecheck            # tsc --noEmit
```

Verify brand configuration loaded from `.env` (parses `COMPANION_BRANDS` and the per-brand JSON env vars):

```bash
npx tsx scripts/verify-brand-config.ts
```

There is no test runner, linter, or formatter wired into `package.json`. Don't claim "tests pass" — there are none.

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
- `src/modules/companion/uppy.routes.ts` — `serveUppyPage` reads `uppy.html` at runtime, fills placeholders (`BEARER_TOKEN_VALUE`, `COMPANION_URL_VALUE`, `ENABLED_PLUGINS_VALUE`, etc.) and serves it. `serveUppyModalJs` transpiles `uppyModal.ts` on demand via `esbuild.transform` — **the `.ts` source is shipped, not the compiled JS**.
- `src/modules/companion/api.routes.ts` + `s3/s3.controller.ts` — custom S3 multipart endpoints (sign-s3, multipart create/sign part/list/complete/abort) signed with the brand's `S3Client`.
- `src/modules/companion/s3/s3.key-builder.ts` — produces keys like `{brand}/original/{userId}/{YYYY}/{M}/{D}/{timestamp}/{filename}`. **Throws** if `req.user` is missing — `requireAuth` on `/api/uppy/*` is responsible for guaranteeing the invariant. Never silently substitute a default userId here; that breaks attribution and OWASP API1 (BOLA).
- `src/modules/auth/` — `extractToken` priority is **`Authorization: Bearer` header → cookie `brand.auth.cookieName`**. The `?bearerToken=` query param is intentionally NOT honored by `extractToken` (would leak the token in proxy/CDN logs, browser history, and Referer — OWASP ASVS V8.3.1). The `/uppy` page is the one place that still accepts `?bearerToken=`: it validates, sets an HttpOnly cookie, and 302-redirects to a URL stripped of the query param. `authenticate` GETs `brand.auth.url` with the token as a cookie; user shape validated by Zod. **`requireAuth` is mounted on `apiRouter`** (`/api/uppy/*`) and enforces three gates: `req.brand` resolved, `brand.auth.url` configured (else 403), and a valid token (else 401). Brands without `auth.url` cannot receive uploads. `attachUser` remains the optional/best-effort variant for routes outside `/api/uppy/*`.
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
