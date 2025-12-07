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

# Per-brand auth URL (returns 200 + user data if authenticated)
BRAND_A_AUTH_URL=https://api.brand-a.com/api/user
BRAND_B_AUTH_URL=https://api.brand-b.com/api/user

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

1. **Request Ingress**: `GET /brand-a/send-token`
2. **Server (`server.ts`)**: Matches the `/:brandId` route prefix.
3. **Brand Middleware**: Looks up "brand-a" in the registry. If found, mounts `req.brand`.
4. **Companion Router**: Forwards the request to the specific Companion instance created for "brand-a".
5. **Provider Interaction**: The Companion instance uses the credentials isolated for "brand-a" to communicate with 3rd party providers or S3.

### Default Brand & Configuration

- The **First Brand** listed in `COMPANION_BRANDS` is considered the **Default Brand**.
- If `COMPANION_BRANDS` is not set, it defaults to a single brand named `default`.
- **Configuration Hierarchy**:
    1. **Brand JSON**: Values defined in the brand's JSON environment variable (e.g., `MYBRAND='{"..."}'`) take precedence.
    2. **Global Fallback**:
        - **Providers/S3**: If missing in JSON, the system falls back to global environment variables (e.g., `COMPANION_GOOGLE_KEY`, `AWS_BUCKET_NAME`).
        - **Auth URL**: **Must** be defined in the brand's JSON. There is no global fallback for `authUrl`.

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
