# Companion Platform Multi-Brand

Multi-brand Uppy Companion server with TypeScript. A single Express server hosts multiple isolated Uppy Companion instances, each configured for a specific "Brand".

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

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Express Server                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                        Brand Registry                                ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              ││
│  │  │   Brand A    │  │   Brand B    │  │   Brand C    │  ...         ││
│  │  │  Companion   │  │  Companion   │  │  Companion   │              ││
│  │  │  Instance    │  │  Instance    │  │  Instance    │              ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘              ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
         │                     │                     │
         ▼                     ▼                     ▼
    ┌─────────┐           ┌─────────┐           ┌─────────┐
    │ AWS S3  │           │ OAuth   │           │ Auth    │
    │ Bucket  │           │Providers│           │ Backend │
    └─────────┘           └─────────┘           └─────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Brand Registry** | Initializes and holds configuration for all active brands from environment variables |
| **Brand Middleware** | Identifies the target brand from the URL (`/:brandId/...`) and attaches the `Brand` object to the request |
| **Companion Factory** | Creates a dedicated Uppy Companion Express app instance for each brand with brand-specific credentials |

---

## Request Flow

```
Request: GET /brand-a/dropbox/list
                │
                ▼
┌───────────────────────────────┐
│ 1. Brand Resolution           │  ← Attaches req.brand = Brand A
└───────────────────────────────┘
                │
                ▼
┌───────────────────────────────┐
│ 2. Authentication (Optional)  │  ← Validates token against brand.auth.url
└───────────────────────────────┘
                │
                ▼
┌───────────────────────────────┐
│ 3. Companion Handling         │  ← Uses Brand A's OAuth credentials
└───────────────────────────────┘
                │
                ▼
┌───────────────────────────────┐
│ 4. Response                   │  ← Returns Dropbox file list
└───────────────────────────────┘
```

---

## API Endpoints

### Global Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/healthz` | Health check | No |
| `GET` | `/api/brands` | List all configured brands | No |

### Brand-Scoped Endpoints

All brand endpoints are prefixed with `/{brandId}`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/{brandId}/uppy` | Uppy upload page (HTML) |
| `GET` | `/{brandId}/uppyModal.js` | Uppy modal JavaScript |
| `GET/POST` | `/{brandId}/api/uppy/sign-s3` | Sign S3 upload URL |
| `POST` | `/{brandId}/api/uppy/s3/multipart` | Create multipart upload |
| `GET` | `/{brandId}/api/uppy/s3/multipart/:uploadId/:partNumber` | Sign individual part |
| `GET` | `/{brandId}/api/uppy/s3/multipart/:uploadId` | List parts (for resume) |
| `POST` | `/{brandId}/api/uppy/s3/multipart/:uploadId/complete` | Complete multipart upload |
| `DELETE` | `/{brandId}/api/uppy/s3/multipart/:uploadId` | Abort multipart upload |
| `*` | `/{brandId}/*` | Companion OAuth endpoints (dropbox, drive, etc.) |

---

## Authentication Flow

The server supports multiple authentication methods with the following priority:

```
1. Authorization Header  →  Bearer xxx
         ↓ (if missing)
2. Brand Cookie          →  cookies[brand.auth.cookieName]
         ↓ (if missing)
3. Query Parameter       →  ?bearerToken=xxx
```

### How It Works

1. **Token Extraction**: The server extracts the token from the request using the priority above
2. **Backend Validation**: If `brand.auth.url` is configured, the token is validated against that endpoint
3. **User Attachment**: On successful validation, `req.user` is populated with user data

```typescript
// Token validation request to brand backend
GET {brand.auth.url}
Headers:
  Authorization: Bearer {token}
  Cookie: {brand.auth.cookieName}={token}

// Expected 200 response:
{
  "id": "user-123",
  "email": "user@example.com",
  "name": "John Doe",
  "roles": ["admin"]
}
```

> **Note**: If `brand.auth.url` is not configured, authentication is disabled and all requests are allowed.

---

## S3 Upload Key Format

Files are organized in S3 using the following path structure:

```
{brand}/original/{userId}/{YYYY}/{M}/{D}/{timestamp}/{filename}

Example:
brand-a/original/user-123/2026/1/26/1737895200000/image.jpg
```

---

## Environment Configuration

### Required Variables

```env
COMPANION_SECRET=your-secret-at-least-16-chars  # Minimum 16 characters
COMPANION_BRANDS=brand-a,brand-b                # Comma-separated brand slugs
```

### Server Configuration

```env
COMPANION_PORT=3020
COMPANION_BIND_HOST=0.0.0.0
COMPANION_HOST=localhost:3020        # Public host for OAuth callbacks
COMPANION_PROTOCOL=http              # http or https
```

### Global Defaults (Fallback)

These are used when brand-specific config is not provided:

```env
# AWS S3
AWS_BUCKET_NAME=your-bucket
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key          # Optional if using IAM roles
AWS_SECRET_ACCESS_KEY=your-secret-key      # Optional if using IAM roles

# Google (OAuth + Picker)
COMPANION_GOOGLE_CLIENT_ID=xxx
COMPANION_GOOGLE_CLIENT_SECRET=xxx
COMPANION_GOOGLE_DRIVE_API_KEY=xxx
COMPANION_GOOGLE_PHOTOS_API_KEY=xxx
COMPANION_GOOGLE_APP_ID=xxx

# Other Providers
COMPANION_DROPBOX_KEY=xxx
COMPANION_DROPBOX_SECRET=xxx
COMPANION_FACEBOOK_KEY=xxx
COMPANION_FACEBOOK_SECRET=xxx
# ... etc for instagram, onedrive, box, unsplash, zoom
```

---

## Brand Configuration (JSON)

Each brand is configured via a JSON environment variable. The variable name is derived from the brand slug:

| Brand Slug | Environment Variable |
|------------|---------------------|
| `brand-a` | `BRAND_A` |
| `my-app` | `MY_APP` |
| `abeduls` | `ABEDULS` |

### Complete Example

```env
ABEDULS='{
    "companionUrl": "https://companion.abeduls.com/abeduls",
    
    "auth": {
        "url": "https://api.abeduls.com/api/user",
        "cookieName": "session"
    },
    
    "public": {
        "backendUrl": "https://api.abeduls.com",
        "uploadUrl": "https://api.abeduls.com/api/frame/contents/upload/public"
    },
    
    "corsOrigins": [
        "https://app.abeduls.com",
        "https://designer.abeduls.com"
    ],
    
    "uploadUrls": ["https://my-bucket.s3.amazonaws.com"],
    
    "s3": {
        "bucket": "abeduls-uploads",
        "region": "us-east-1",
        "accessKey": "AKIA...",
        "secretKey": "xxx",
        "useAccelerateEndpoint": false
    },
    
    "providers": {
        "google": {
            "clientId": "xxx.apps.googleusercontent.com",
            "clientSecret": "xxx",
            "driveApiKey": "AIza...",
            "photosApiKey": "AIza...",
            "appId": "123456789"
        },
        "dropbox": {
            "key": "xxx",
            "secret": "xxx"
        }
    }
}'
```

### Configuration Priority

```
1. Brand JSON config     →  Highest priority
         ↓ (if missing)
2. Global env variables  →  Fallback for providers/S3
```

### JSON Schema Reference

| Field | Type | Description |
|-------|------|-------------|
| `companionUrl` | `string` | Public URL for OAuth callbacks (important behind proxies) |
| `auth.url` | `string` | Endpoint to validate user tokens |
| `auth.cookieName` | `string` | Cookie name for session (default: `session`) |
| `public.backendUrl` | `string` | Public backend API URL |
| `public.uploadUrl` | `string` | Public upload endpoint |
| `corsOrigins` | `string[]` | Allowed CORS origins |
| `uploadUrls` | `string[]` | Allowed upload destination URLs |
| `s3.bucket` | `string` | S3 bucket name |
| `s3.region` | `string` | AWS region |
| `s3.accessKey` | `string` | AWS access key (optional with IAM) |
| `s3.secretKey` | `string` | AWS secret key (optional with IAM) |
| `s3.useAccelerateEndpoint` | `boolean` | Use S3 Transfer Acceleration |
| `providers.*` | `object` | Provider-specific OAuth credentials |

---

## Supported Providers

| Provider | Config Key | Required Fields |
|----------|------------|-----------------|
| Google Drive | `providers.google` | `clientId`, `clientSecret` |
| Google Drive Picker | `providers.google` | `clientId`, `driveApiKey`, `appId` |
| Google Photos Picker | `providers.google` | `clientId`, `photosApiKey`, `appId` |
| Dropbox | `providers.dropbox` | `key`, `secret` |
| Facebook | `providers.facebook` | `key`, `secret` |
| Instagram | `providers.instagram` | `key`, `secret` |
| OneDrive | `providers.onedrive` | `key`, `secret` |
| Box | `providers.box` | `key`, `secret` |
| Unsplash | `providers.unsplash` | `key`, `secret` |
| Zoom | `providers.zoom` | `key`, `secret` |

---

## Project Structure

```
src/
├── config/                     # Environment configuration (Zod)
├── core/types/                 # Shared TypeScript interfaces
├── lib/aws/                    # AWS S3 client utilities
├── modules/
│   ├── auth/
│   │   ├── auth.service.ts     # Token extraction & validation
│   │   ├── auth.middleware.ts  # User attachment middleware
│   │   └── auth.types.ts       # AuthUser, AuthResult interfaces
│   ├── brand/
│   │   ├── brand.service.ts    # Brand creation & registry
│   │   ├── brand.middleware.ts # Brand resolution middleware
│   │   └── brand.types.ts      # Brand interface definitions
│   └── companion/
│       ├── companion.factory.ts # Creates isolated Companion apps
│       ├── api.routes.ts        # S3 signing endpoints
│       ├── uppy.routes.ts       # Uppy page & modal serving
│       ├── uppy.html            # Upload page template
│       └── s3/
│           ├── s3.controller.ts # S3 multipart handlers
│           └── s3.key-builder.ts # S3 key generation
├── server.ts                   # Express app assembly
└── index.ts                    # Entry point (HTTP server + WebSocket)
```

---

## Troubleshooting

### Brands not loading

1. Verify `COMPANION_BRANDS` contains your brand slugs
2. Check the corresponding JSON env var exists (e.g., `BRAND_A` for `brand-a`)
3. Run the verifier script:
   ```bash
   npx ts-node scripts/verify-brand-config.ts
   ```

### OAuth redirect goes to /default

This happens when Companion doesn't know the correct public URL.

**Solution**: Set `companionUrl` in your brand JSON:
```json
{
    "companionUrl": "https://companion.your-domain.com/your-brand"
}
```

### /uppy returns Unauthorized

1. Verify `auth.url` is reachable and returns HTTP 200 for valid sessions
2. Check the cookie name matches `auth.cookieName` (default: `session`)
3. Ensure the token is being sent via header, cookie, or query param

### S3 uploads failing

1. Verify S3 credentials in brand JSON or global env vars
2. Check bucket CORS configuration allows your origins
3. Ensure `uploadUrls` includes your S3 bucket URL

### OAuth callback errors

1. Verify OAuth redirect URIs in provider console match:
   ```
   {companionUrl}/connect/{provider}/callback
   ```
2. Check `companionUrl` is accessible from the internet
3. Verify provider credentials are correct

---

## Default Brand Behavior

- The **first brand** in `COMPANION_BRANDS` is the **default brand**
- If `COMPANION_BRANDS` is not set, a single brand named `default` is created
- Auth is disabled for brands without `auth.url` configured

---

## Development

```bash
# Run with hot reload
pnpm dev

# Type checking
pnpm typecheck

# Linting
pnpm lint

# Build
pnpm build
```

## License

MIT
