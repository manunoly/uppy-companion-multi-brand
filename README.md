# Companion Platform Multi-Brand

Multi-brand Uppy Companion server with TypeScript. A single Express server hosts multiple isolated Uppy Companion instances, each resolved by the inbound `Host` header and configured for a specific brand. Brand/auth model is aligned with abeduls3's `@package/brands` contract (partner-whoami auth, Redis-backed state, hardened for production on Railway).

## Requirements

- Node.js 22+
- pnpm
- Redis (local instance or Railway's Redis plugin) — required for sessions, the whoami cache/circuit breaker, and rate limiting

## Quick Start

```bash
# Install dependencies
pnpm install

# Create .env file
cp .env.example .env

# Run in development
pnpm dev

# Build for production
pnpm build
pnpm start
```

Only the `edo` brand is servable out of the box (see `src/modules/brand/registry.ts`). For local dev, set `BRAND_FORCE=edo` in `.env` (brand resolution by `Host` won't match `localhost` against edo's real prod/stage hostnames) — see "Local development" below.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           Express Server (per replica)                    │
│  ┌───────────────────────────────────────────────────────────────────────┐│
│  │              Brand Registry (registry.ts + <SLUG>_BRAND_OVERRIDE)     ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                ││
│  │  │     edo      │  │     abe      │  │   picaboo    │  (not servable ││
│  │  │  Companion   │  │ (not servable│  │ (not servable│   yet — see    ││
│  │  │  Instance    │  │     yet)     │  │     yet)     │   registry.ts) ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘                ││
│  └───────────────────────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────────┘
         │                     │                          │
         ▼                     ▼                          ▼
    ┌─────────┐          ┌───────────┐               ┌─────────┐
    │ AWS S3  │          │  Partner  │               │  Redis  │
    │ Bucket  │          │  whoami   │               │ (shared │
    │(1/brand)│          │ endpoint  │               │  state) │
    └─────────┘          └───────────┘               └─────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Base brand registry** | Code-only, deep-frozen config per known slug (`src/modules/brand/registry.ts`) — hosts, S3 bucket, OAuth plugin list, auth endpoints |
| **`<SLUG>_BRAND_OVERRIDE`** | Per-environment override (auth string fields only — `whoamiUrl`/`signInUrl`/`signOutUrl`/`sessionCookieName`), merged in at boot with an SSRF-safe allowlist (`src/modules/brand/identity.ts`) |
| **Host-based resolution** | Each servable brand answers on its own `companionHosts` (code-only); an inbound request is routed by matching the `Host` header (`src/modules/brand/detect.ts`) — no `/{brandId}/...` path prefix |
| **Session resolver** | Validates the caller by forwarding their session cookie to the brand's `whoamiUrl` (`partner-whoami`/`capsule`), with an SSRF gate, a Redis-backed circuit breaker, and a short-lived cache (`src/modules/auth/session-resolver.ts`) |
| **Companion Factory** | Creates a dedicated Uppy Companion Express app instance for each servable brand with brand-specific OAuth credentials |

---

## Request Flow

```
Request: Host: companion.stage.entourageyearbooks.com   GET /uppy
                │
                ▼
┌────────────────────────────────────┐
│ 1. Host-based brand resolution     │  ← resolveBrandByHost(Host) -> req.brand (or 404 "Unknown host")
└────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────┐
│ 2. attachUser (session-resolver)   │  ← forwards the request's session cookie to brand.auth.whoamiUrl
└────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────┐
│ 3. /uppy / /api/uppy/* handling    │  ← uses req.user already populated above (no re-auth)
└────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────┐
│ 4. Response                        │  ← Uppy upload page / signed S3 URL / OAuth provider passthrough
└────────────────────────────────────┘
```

See `CLAUDE.md`'s "Architecture" section for the full middleware chain (rate limiting, CSP, readiness, etc.) in exact order.

---

## API Endpoints

Every brand's endpoints live at the SAME paths, differentiated only by which `Host` you hit (each servable brand owns its own `companionHosts`) — there is no `/{brandId}/...` prefix.

### Global Endpoints (answer regardless of Host)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/healthz` | Liveness check | No |
| `GET` | `/api/readyz` | Readiness check (Redis `PING` + S3 `HeadBucket`) | No |
| `GET` | `/api/brands` | List configured brands (masked); `?key=HEALTH_CHECK_KEY` unlocks the detailed view | No / key-gated detail |

### Brand Endpoints (resolved by `Host`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/uppy` | Uppy upload page (HTML) |
| `GET` | `/uppyModal.js` | Uppy modal JavaScript |
| `GET/POST` | `/api/uppy/sign-s3` | Sign S3 upload URL |
| `POST` | `/api/uppy/s3/multipart` | Create multipart upload |
| `GET` | `/api/uppy/s3/multipart/:uploadId/:partNumber` | Sign individual part |
| `GET` | `/api/uppy/s3/multipart/:uploadId` | List parts (for resume) |
| `POST` | `/api/uppy/s3/multipart/:uploadId/complete` | Complete multipart upload |
| `DELETE` | `/api/uppy/s3/multipart/:uploadId` | Abort multipart upload |
| `*` | `/*` | Falls through to the resolved brand's isolated `@uppy/companion` instance (OAuth connect/callback, etc.) |

---

## Authentication Flow (`partner-whoami` / `capsule`)

Companion **never** issues or validates a session cookie itself — it forwards whatever cookie the browser already sends it to the brand's own `whoamiUrl`, and trusts that endpoint's answer. Tokens are never embedded in HTML, URLs, or query strings (OWASP ASVS V8.3.1); there is no `Authorization: Bearer`/`?bearerToken=` support anywhere.

### How It Works

1. The user logs into the brand's own dashboard (e.g. `edonext.entourageyearbooks.com`). The brand backend sets a session cookie scoped to the shared apex (e.g. `Domain=.entourageyearbooks.com`).
2. Because Companion's own host lives under that same apex (`companion.entourageyearbooks.com`/`companion.stage.entourageyearbooks.com` for edo — `companionHosts` in `registry.ts`), the browser sends that cookie to Companion automatically, same-site.
3. On `GET /uppy`, `attachUser` (`src/modules/auth/session-resolver.ts#resolveSession`) reads the named cookie and forwards it to `brand.auth.whoamiUrl` with a hardened flow: SSRF-gated URL validation (`whoamiAllowedHosts`), `redirect: 'manual'`, a 5s timeout, a 16KB response body cap, a Redis-backed circuit breaker (3 failures -> 30s open, half-open probe), and a 45s Redis cache keyed by `sha256(cookie)`. A `200` response is mapped through `responseMapping` into the canonical `{id, email, displayName, imageUrl}` shape (plus `edoId` for the `edo` brand specifically). If the cookie is missing/invalid, Companion 302s to `brand.auth.signInUrl?redirect=<full url>` (or renders a static error page if unset).
4. Cross-origin XHRs from the upload page to the brand's own upload-notification endpoint use `credentials: 'include'`. Per-brand CORS (`src/core/cors.ts`) echoes the request `Origin` (with `Allow-Credentials: true`) only when it matches `*.<apex>` (the bare domain from `whoamiAllowedHosts[0]`) and is HTTPS in production.

```typescript
// Whoami validation request, forwarded server-to-server by Companion
GET {brand.auth.whoamiUrl}
Headers:
  Cookie: {brand.auth.sessionCookieName}={value}

// Expected 200 response (field names configurable per brand via responseMapping):
{
  "id": "1004",
  "email": "user@example.com",
  "name": "John Doe",
  "profile_photo_url": "https://..."
}
```

> A brand with an invalid/off-allowlist `whoamiUrl` is `misconfigured` (403 on `/api/uppy/*`, static error page on `/uppy`) — this can only happen from a bad `<SLUG>_BRAND_OVERRIDE`, since the base registry's `whoamiUrl` always passes its own `whoamiAllowedHosts` check. Run `npx tsx scripts/verify-brand-config.ts` to catch this before deploying.

---

## S3 Upload Key Format

Files are organized in S3 using a single scheme, identical for every brand (no branching on brand/auth kind — `src/modules/companion/s3/s3.key-builder.ts`):

```
{s3Prefix}original/{userId}/{YYYY}/{M}/{D}/{timestamp}/{filename}

Example (edo, s3Prefix=""):
original/1004/2026/7/2/73412991/image.jpg
```

`userId` is always the canonical `user.id` from the whoami response — **never** a brand-specific secondary id (e.g. edo's `edoId`, which exists only as listing metadata, see `enrich-edo.ts`). Per-brand isolation is by S3 **bucket**, not by a `{brand}/` key prefix (`s3Prefix` is empty for edo).

---

## Environment Configuration

See `.env.example` for the full, authoritative, commented list — this section only summarizes the categories.

### Required Variables

```env
COMPANION_SECRET=your-secret-at-least-16-chars   # >= 16 chars, shared across every brand
```

### Server / Ops Configuration

```env
COMPANION_PORT=3020
COMPANION_BIND_HOST=0.0.0.0
COMPANION_HOST=localhost:3020        # informational only — see .env.example
COMPANION_PROTOCOL=http              # http or https
REDIS_URL=redis://localhost:6379     # Railway's Redis plugin in production
HEALTH_CHECK_KEY=...                 # gates the detailed /api/brands view
RATE_LIMIT_*  / RATE_LIMIT_GLOBAL_*  # see .env.example
```

### Brand selection & override

```env
BRAND_FORCE=edo                      # routes every request to one slug regardless of Host
EDO_BRAND_OVERRIDE={"auth":{...}}    # auth string fields only — see .env.example for the full worked example
```

### Per-brand secrets (`SECRETS_SOURCE=env` default, or `aws`)

```env
SECRETS_SOURCE=env
EDO_S3_ACCESS_KEY=...
EDO_S3_SECRET_KEY=...
EDO_S3_BUCKET=entourage-uploads
EDO_S3_REGION=us-east-1
EDO_DROPBOX_KEY=... / EDO_DROPBOX_SECRET=...
EDO_GOOGLE_CLIENT_ID=...
# ... full per-provider scheme, and the SECRETS_SOURCE=aws alternative, in .env.example
```

---

## Brand Configuration (code + override, NOT a JSON blob)

A brand is no longer configured by dropping a giant JSON blob into one env var. Instead:

1. **Base registry** (`src/modules/brand/registry.ts`) — a deep-frozen, code-reviewed entry per known slug (`abe`, `picaboo`, `edo`). Holds everything that must never vary by environment or be attacker-influenced: `kind`, `whoamiAllowedHosts` (SSRF allowlist), `assets.s3Prefix`, `companionHosts` (which hosts route to this brand).
2. **`<SLUG>_BRAND_OVERRIDE`** (JSON, env var) — the only per-environment knob. Merges over the base registry's `auth` object, and **only** these string fields: `whoamiUrl`, `signInUrl`, `signOutUrl`, `sessionCookieName`. Everything else in an override is dropped (logged as a warning) — see `.env.example` for a worked stage-pointing example.
3. **Per-brand secrets** (`src/lib/secrets.ts#loadBrandSecrets`) — S3 credentials and OAuth provider keys, loaded from either plain env vars (`SECRETS_SOURCE=env`, the Railway default) or AWS Secrets Manager (`SECRETS_SOURCE=aws`).

A brand only becomes servable (gets a Companion instance, gets its secrets loaded, can be resolved by `Host`) once its base registry entry has a non-empty `companionHosts` — today, that's just `edo`.

### Adding/enabling a brand

There is no user-facing "add a brand" flow — it's a code change:

1. Add or edit the brand's entry in `src/modules/brand/registry.ts` (name, `domains`, `companionHosts`, `auth` defaults, `assets.s3Prefix`, `upload.plugins`, `limits`, `companionUrl`, base `s3.bucket`/`region`).
2. Set that brand's per-environment secrets (`.env.example`'s "PER-BRAND SECRETS" section) and, if needed, an environment-specific `<SLUG>_BRAND_OVERRIDE` (e.g. to point at stage).
3. Run `npx tsx scripts/verify-brand-config.ts` — it prints the fully-resolved, secret-masked config for every known slug and fails (non-zero exit) on a blocking issue in a servable brand (invalid `BRAND_FORCE`, or a `whoamiUrl` that fails its own SSRF allowlist).

---

## Supported Providers

Wired only for the plugins listed in a brand's `upload.plugins` (`src/modules/companion/companion.factory.ts`), not merely because credentials happen to be present:

| Provider | `upload.plugins` value | Config Key | Required Fields |
|----------|------------------------|------------|-----------------|
| Google Drive Picker | `GoogleDrivePicker` | `<PREFIX>_GOOGLE_*` | `clientId`, `driveApiKey`, `appId` |
| Google Photos Picker | `GooglePhotosPicker` | `<PREFIX>_GOOGLE_*` | `clientId`, `photosApiKey`, `appId` |
| Dropbox | `Dropbox` | `<PREFIX>_DROPBOX_KEY`/`_SECRET` | `key`, `secret` |
| Facebook | `Facebook` | `<PREFIX>_FACEBOOK_KEY`/`_SECRET` | `key`, `secret` |
| URL import | `Url` | (none — Companion's built-in "import from URL") | — |

`CompanionProviders` (the config shape) also declares `instagram`/`onedrive`/`box`/`unsplash`/`zoom`, but no `upload.plugins` value maps to them today — they exist for structural completeness only and get no OAuth wiring.

---

## Project Structure

```
src/
├── config/                        # Global, brand-independent env config (Zod)
├── core/
│   ├── cors.ts                    # Per-brand CORS (apex from whoamiAllowedHosts[0])
│   ├── csp.ts                     # Per-brand CSP directive builders
│   └── types/                     # AppRequest (brand?, user?)
├── lib/
│   ├── aws/s3Client.ts            # S3Client factory
│   ├── logger.ts                  # Pino + AsyncLocalStorage
│   ├── redis.ts                   # Shared ioredis singleton
│   └── secrets.ts                 # loadBrandSecrets (env / aws sources)
├── modules/
│   ├── auth/
│   │   ├── session-resolver.ts    # resolveSession — the partner-whoami flow
│   │   ├── whoami-breaker.ts      # Redis-backed circuit breaker
│   │   ├── enrich-edo.ts          # edo-only edoId/email enrichment
│   │   └── auth.middleware.ts     # attachUser / requireAuth
│   ├── brand/
│   │   ├── slugs.ts               # BrandSlug ('abe' | 'picaboo' | 'edo')
│   │   ├── brand.contract.ts      # The brand type contract
│   │   ├── registry.ts            # Code-only base registry (deep-frozen)
│   │   ├── identity.ts            # <SLUG>_BRAND_OVERRIDE merge + SSRF gate
│   │   ├── detect.ts              # resolveBrandByHost + BRAND_FORCE
│   │   ├── brand.schema.ts        # Zod structural validation
│   │   └── brand.service.ts       # resolveBrand / createBrandRegistry
│   ├── companion/
│   │   ├── companion.factory.ts   # Creates isolated Companion apps
│   │   ├── api.routes.ts          # S3 signing endpoints
│   │   ├── uppy.routes.ts         # Uppy page & modal serving
│   │   ├── uppy.html              # Upload page template
│   │   └── s3/
│   │       ├── s3.controller.ts   # S3 multipart handlers
│   │       └── s3.key-builder.ts  # S3 key generation (id-based, brand-agnostic)
│   └── folders/folders.service.ts # Optional folder list (degrades to [])
├── server.ts                      # assembleApp / createServer
└── index.ts                       # Entry point (HTTP server + WebSocket + graceful shutdown)
```

---

## Troubleshooting

### A brand isn't loading / isn't reachable

1. Confirm it's servable: `getServableSlugs()` requires a non-empty `companionHosts` in `registry.ts` — `abe`/`picaboo` are intentionally NOT servable yet.
2. Run the verifier:
   ```bash
   npx tsx scripts/verify-brand-config.ts
   ```
   It prints every known brand's effective config (registry + override + secrets, masked) and flags blocking issues.
3. Confirm the `Host` header your client is sending matches one of the brand's `companionHosts` exactly (case/port-insensitive) — or set `BRAND_FORCE=<slug>` for local dev.

### `/uppy` redirects to login / returns a static error page

1. That's `attachUser` not finding a valid session — check that the cookie your client sent matches `auth.sessionCookieName` (post-override) and that the brand's `whoamiUrl` is reachable and returns `200` for a valid session (use `scripts/smoke-whoami-stage.ts` against stage to test this in isolation).
2. `503` on `/api/uppy/*` means the whoami endpoint is down or the circuit breaker is open (3 recent failures) — wait ~30s or check the partner's status.
3. `403` means the brand's auth config itself is `misconfigured` (an override's `whoamiUrl` failed its own SSRF allowlist) — fix the override and re-run `verify-brand-config.ts`.

### OAuth callback errors

1. Verify OAuth redirect URIs in the provider console match `{brand.companionUrl}/connect/{provider}/callback`.
2. Confirm `companionUrl` (registry.ts) is reachable from the internet and its host is included in `server.validHosts` (derived automatically from `companionUrl`/`companionHosts` — see `companion.factory.ts`).
3. Verify the provider credentials for that brand (`<PREFIX>_<PROVIDER>_KEY`/`_SECRET`) are set.

### S3 uploads failing

1. Run `verify-brand-config.ts` — a servable brand missing S3 credentials fails loudly there, not silently at upload time.
2. Check the bucket's CORS configuration allows the brand's designer origin(s) (`domains` in the registry).
3. Confirm the declared `Content-Length`/`Content-Type` of the upload is within `brand.limits` (`maxUploadBytes`/`allowedContentTypes`).

---

## Development

```bash
pnpm dev              # Hot reload via tsx watch
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm test             # vitest run (single pass)
pnpm test:watch       # vitest in watch mode
pnpm test:coverage    # vitest run --coverage (V8); fails CI below 70/60/70/70
pnpm build            # tsc -p tsconfig.build.json + browser asset bundling
```

### Local development (against `edo`)

Only `edo` is servable, and its `companionHosts` are fixed to the real prod/stage hostnames (code-only, never overridable) — so `Host`-based resolution won't match anything on your machine. For local dev:

1. Set `BRAND_FORCE=edo` in `.env` — every request resolves to edo regardless of `Host`.
2. Point auth at a reachable environment via `EDO_BRAND_OVERRIDE` (stage is the usual choice — the worked example is in `.env.example`). Do **not** try to override `companionHosts`/`kind`/`whoamiAllowedHosts` — they're code-only.
3. Start a local Redis (e.g. `docker run -p 6379:6379 redis`) — sessions, the whoami cache, the circuit breaker, and rate limiting all require one. `REDIS_URL` defaults to `redis://localhost:6379`.
4. Set `EDO_S3_ACCESS_KEY`/`EDO_S3_SECRET_KEY` (or the global `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` fallback) so `loadBrandSecrets` doesn't fail at boot.
5. Verify before `pnpm dev`:
   ```bash
   npx tsx scripts/verify-brand-config.ts
   ```
   Should report no blocking issues for `edo`.
6. Before wiring up a full local browser session, `scripts/smoke-whoami-stage.ts` can validate that a real stage session cookie is accepted end-to-end (server-to-server, no browser needed) — see that file's header comment for how to obtain a cookie and what it confirms.

## License

MIT
