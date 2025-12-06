FROM node:22-alpine AS base
WORKDIR /app

# 1. Install dependencies only when needed
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# 2. Production dependencies only
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# 3. Rebuild the source code only when needed
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable pnpm && pnpm run build

# Copy static assets and TS files needed for runtime transpilation using standard cp
# We need to preserve the directory structure under dist/
RUN mkdir -p dist/modules/companion && \
    cp src/modules/companion/uppy.html dist/modules/companion/ && \
    cp src/modules/companion/uppyModal.ts dist/modules/companion/

# 4. Production image, copy all the files and run next
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

EXPOSE 3020
CMD ["node", "dist/index.js"]
