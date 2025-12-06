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

## Project Structure

```
src/
├── config/         # Environment configuration
├── core/types/     # Shared types
├── modules/
│   ├── auth/       # Authentication module
│   ├── brand/      # Multi-brand support
│   └── companion/  # Uppy Companion integration
├── server.ts       # Express app
└── index.ts        # Entry point
```
