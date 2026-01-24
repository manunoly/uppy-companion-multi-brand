# Companion Platform

Multi-brand Companion server with TypeScript.

## Requirements

- Node.js 22+
- pnpm

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

## Environment Variables

```env
# Server
COMPANION_PORT=3020
COMPANION_BIND_HOST=0.0.0.0
COMPANION_HOST=localhost:3020
COMPANION_PROTOCOL=http
COMPANION_SECRET=your-secret-at-least-16-chars

# Brands (comma-separated)
COMPANION_BRANDS=brand-a,brand-b

# ===========================================
# BRAND CONFIGURATION (JSON)
# ===========================================
# Each brand is configured via a JSON string stored in an environment variable.
#
# ENV VAR NAME RULES (same logic as in src/modules/brand/brand.service.ts):
# - Take the brand slug from COMPANION_BRANDS
# - Normalize: lowercase, trim, replace non [a-z0-9-] with '-'
# - Convert '-' to '_' and uppercase
#
# Examples:
#   "brand-a"        -> BRAND_A
#   "another-brand"  -> ANOTHER_BRAND
#
# The JSON can include authUrl, companionUrl (proxy/public URL override), corsOrigins,
# uploadUrls, s3 config, and provider credentials.
BRAND_A='{
    "authUrl": "https://api.brand-a.com/api/user",
    "companionUrl": "https://companion.brand-a.com/brand-a",
    "authCookieName": "session",
    "corsOrigins": ["https://app.brand-a.com"],
    "uploadUrls": ["https://my-bucket.s3.amazonaws.com"],
    "s3": {
        "bucket": "my-bucket",
        "region": "us-east-1",
        "useAccelerateEndpoint": false
    },
    "providers": {
        "google": { "key": "...", "secret": "..." },
        "dropbox": { "key": "...", "secret": "..." }
    }
}'

# S3 (global defaults)
AWS_BUCKET_NAME=your-bucket
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# Providers (global defaults)
COMPANION_GOOGLE_KEY=your-google-client-id
COMPANION_GOOGLE_SECRET=your-google-client-secret
COMPANION_DROPBOX_KEY=your-dropbox-key
COMPANION_DROPBOX_SECRET=your-dropbox-secret
```

## Architecture

The platform uses a **multi-tenant architecture** where a single Express server hosts multiple isolated Uppy Companion instances, each configured for a specific "Brand".

### Key Concepts

- **Brand Registry**: Initializes and holds configuration for all active brands. Brands are defined via environment variables (e.g., `BRAND_A_...`).
- **Brand Middleware**: Identifies the target brand from the URL (e.g., `/:brandId/...`) and attaches the `Brand` object to the request.
- **Companion Factory**: Creates a dedicated standard Uppy Companion Express app instance for each brand, injecting brand-specific keys (S3, Drive, Dropbox, etc.).

### Request Flow

1. **Request Ingress**: Requests are namespaced under the brand slug, e.g. `GET /brand-a/uppy` or Companion endpoints like `GET /brand-a/dropbox/list`.
2. **Server ([src/server.ts](src/server.ts))**: Creates a `BrandRegistry`, then creates and mounts one isolated Companion app per brand at `/{brandId}`.
3. **Brand Resolution**: For brand-scoped routes, the server attaches `req.brand` with the concrete brand instance.
4. **Companion Handling**: The request is handled by that brand's Companion instance, using that brand's provider credentials and S3 settings.

## Detailed Runtime Flow

### 1) Server boot
- Entry point: [src/index.ts](src/index.ts). Creates an HTTP server, attaches Companion websocket, and handles graceful shutdown.
- Main assembly: [src/server.ts](src/server.ts). Builds the Express app, middleware, brand registry, and mounts a Companion instance per brand.

### 2) Brand configuration resolution
- Brand list is read from `COMPANION_BRANDS`.
- Each brand configuration is parsed from an env var derived from its slug (e.g. `abeduls` → `ABEDULS`).
- The JSON config is parsed in [src/modules/brand/brand.service.ts](src/modules/brand/brand.service.ts). Missing values are filled with global defaults.

### 3) Brand routing model
- Every brand is mounted under its slug path: `/${brandId}`.
- Uppy HTML: `/${brandId}/uppy`.
- Uppy modal JS: `/${brandId}/uppyModal.js` (transpiled on the fly from TS).
- Custom S3 API: `/${brandId}/api/...`.
- Companion itself is mounted at `/${brandId}`.

### 4) Auth flow (cookie + bearer)
- The UI passes a bearer token (optional) to the `/uppy` page.
- The server also accepts auth via a cookie (the cookie name defaults to `session` or brand `authCookieName`).
- Token extraction order: Authorization header → brand cookie → `bearerToken` query param.
- Auth check is performed in [src/modules/auth/auth.service.ts](src/modules/auth/auth.service.ts) against `brand.authUrl`.
- When authenticating against a cookie-based backend, the cookie is forwarded in the auth request headers.

### 5) OAuth redirect flow per brand
- Provider credentials are stored per brand.
- OAuth host/protocol/path are derived per brand in [src/modules/companion/companion.factory.ts](src/modules/companion/companion.factory.ts).
- If `companionUrl` is set in the brand JSON, it is used to generate OAuth URLs and prevent path leakage (e.g. `/default` being appended). Otherwise it falls back to `server.host` + `server.path`.

### 6) S3 uploads
- Simple PUT signing: [src/modules/companion/s3/s3.controller.ts](src/modules/companion/s3/s3.controller.ts) via `/api/uppy/sign-s3`.
- Multipart flow: create → signPart → listParts → complete → abort.
- S3 keys are generated by [src/modules/companion/s3/s3.key-builder.ts](src/modules/companion/s3/s3.key-builder.ts):
    - Format: `{brand}/original/{userId}/{YYYY}/{M}/{D}/{timestamp}/{filename}`.
    - Brand comes from request or metadata.
    - User comes from `req.user` or metadata.

## Environment Configuration Notes

### Required
- `COMPANION_SECRET`: minimum 16 chars (required by schema).
- `COMPANION_BRANDS`: comma-separated slugs.

### Optional (but important)
- `COMPANION_HOST`, `COMPANION_PROTOCOL`: Public base used for OAuth and callback URLs if no `companionUrl` is set.
- `CORS_ALLOWED_ORIGINS`: Comma-separated list, used for Companion CORS.

### Brand JSON (per-brand override)
Preferred fields:
- `auth`: block with `url`, `cookieName`.
- `public`: block with `backendUrl`, `uploadUrl`.
- `companionUrl`: explicit public URL for Companion per brand (recommended behind proxies).
- `providers`: provider credentials by brand (Dropbox, Google, etc.).
- `s3`: bucket/region/credentials override.

Legacy fields are still supported for backwards compatibility:
- `authUrl`, `authCookieName`, `publicBackendUrl`, `publicUploadUrl`.

## Operational Troubleshooting

### Brands not loading
- Verify `COMPANION_BRANDS` and the corresponding uppercase JSON env vars.
- Run the verifier: [scripts/verify-brand-config.ts](scripts/verify-brand-config.ts).

### OAuth redirect goes to /default
- Ensure the brand JSON includes `companionUrl` with the correct path, e.g. `http://localhost:3020/abeduls`.
- Confirm the provider options are built with `oauthDomain`, `oauthProtocol`, and `oauthPath` in [src/modules/companion/companion.factory.ts](src/modules/companion/companion.factory.ts).

### /uppy returns Unauthorized
- Ensure `authUrl` is reachable and returns 200 for the session.
- Confirm the auth cookie name matches `authCookieName` (default `session`).

### Default Brand & Configuration

- The **First Brand** listed in `COMPANION_BRANDS` is considered the **Default Brand**.
- If `COMPANION_BRANDS` is not set, it defaults to a single brand named `default`.
- **Configuration Hierarchy**:
    1. **Brand JSON**: Values defined in the brand's JSON environment variable (e.g., `MYBRAND='{"..."}'`) take precedence.
    2. **Global Fallback**:
        - **Providers/S3**: If missing in JSON, the system falls back to global environment variables (e.g., `COMPANION_GOOGLE_KEY`, `AWS_BUCKET_NAME`).
        - **Auth URL**: **Must** be defined in the brand's JSON to enable auth. If `authUrl` is missing, auth is considered disabled for that brand.

## Project Structure

```
src/
├── config/             # Environment configuration parsing (Zod)
├── core/types/         # Shared TypeScript interfaces
├── modules/
│   ├── auth/           # User session and attachment logic
│   ├── brand/          # Brand configuration, registry, and middleware
│   │   ├── brand.service.ts  # Logic to read env vars & create Brand objects
│   │   └── brand.types.ts    # Brand interface definitions
│   └── companion/      # Uppy Companion integration
│       ├── companion.factory.ts # Creates isolated Companion apps
│       ├── api.routes.ts        # Custom routes (e.g. S3 signing)
│       └── uppy.routes.ts       # Uppy config & modal serving
├── server.ts           # Main Express application assembly
└── index.ts            # Server entry point
```
