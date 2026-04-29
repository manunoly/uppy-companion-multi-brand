# Cookie-only cross-origin upload auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the `BEARER_TOKEN_VALUE` injection from the `/uppy` HTML by switching all auth to first-party cookies scoped to `Domain=.<rootDomain>` (Option A1, D2 cookie-consumer-only, M1 hard-cut).

**Architecture:** Add `rootDomain` and `public.loginUrl` to brand config. Companion only consumes cookies — never sets them on the brand domain. Missing cookie → 302 to `loginUrl?redirect=…`. New per-brand CORS middleware on `/api/uppy/*` accepts any `*.<rootDomain>` origin (HTTPS-only in production). Browser-side `uppyModal.ts` drops the bearer header entirely; all fetches use `credentials: 'include'`.

**Tech Stack:** TypeScript (NodeNext, strict), Express 4, `@uppy/companion`, Zod for runtime config validation, esbuild (build-time) for `uppyModal.ts`.

**Spec:** `docs/superpowers/specs/2026-04-29-cookie-only-cross-origin-auth-design.md`

**Branch:** `feat/cookie-only-auth` (already created from `origin/main`).

---

## File map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/modules/brand/brand.types.ts` | Modify | Add `rootDomain` + `public.loginUrl` to `BrandConfigJSON` and `Brand`. |
| `src/modules/brand/brand.schema.ts` | Modify | Add Zod fields + `superRefine` cross-field validation. |
| `src/modules/brand/brand.service.ts` | Modify | Set `brand.rootDomain` and `brand.public.loginUrl` from config. **NO regex synthesis here.** |
| `src/core/cors.ts` | **Create** | `corsForBrand(brand, envProtocol)` middleware + `escapeRegex` helper. |
| `src/server.ts` | Modify | Mount `corsForBrand` before `apiRouter` per brand. |
| `src/modules/companion/uppy.routes.ts` | Modify | Rewrite `serveUppyPage`: drop queryToken handling, drop `res.cookie()`, drop `BEARER_TOKEN_VALUE` placeholder, add `redirectToLoginOrShowError`, add `Cache-Control: no-store`. |
| `src/modules/companion/uppy.html` | Modify | Remove `BEARER_TOKEN_VALUE` placeholder + the `bearerToken` JS literal. |
| `src/modules/companion/uppyModal.ts` | Modify | Remove `bearerToken` option, remove `authHeaders`/`mergeHeaders`, simplify `fetchWithAuth` to `credentials: 'include'`. |
| `src/modules/auth/auth.service.ts` | Modify | Update `extractToken` JSDoc comment — remove the stale reference to the `/uppy` query-token exchange (which no longer exists). |
| `scripts/verify-brand-config.ts` | Modify | Assert `rootDomain` present when `auth.url` set; warn on missing `loginUrl`. |
| `.env.example` | Modify | Document `rootDomain` and `public.loginUrl` in the brand JSON template. |
| `CLAUDE.md` | Modify | Update auth-flow gotcha to reflect cookie-only model. |

**Note on testing:** the codebase has no test framework. Verification per task is `pnpm typecheck` + targeted manual smoke tests (curl / browser DevTools). Adding Vitest is tracked separately as audit top-10 #7.

---

## Task 1: Brand config schema (types + Zod + service)

**Files:**
- Modify: `src/modules/brand/brand.types.ts`
- Modify: `src/modules/brand/brand.schema.ts`
- Modify: `src/modules/brand/brand.service.ts`

- [ ] **Step 1.1: Add `rootDomain` and `public.loginUrl` to `BrandConfigJSON`**

In `src/modules/brand/brand.types.ts`, modify the `BrandConfigJSON` interface. Find the existing `displayName` and `public` block, add the two new fields:

```ts
export interface BrandConfigJSON {
    /** Human-readable name shown in the UI. Falls back to the slug when omitted. */
    displayName?: string;
    /** Brand's registrable domain (e.g. "abeduls.com"). Required when auth.url is set:
     *  drives the per-brand CORS regex on /api/uppy/* and documents the cookie scope. */
    rootDomain?: string;
    /** Preferred: auth configuration block */
    auth?: {
        url?: string;
        cookieName?: string;
    };
    /** Preferred: public URLs configuration block */
    public?: {
        backendUrl?: string;
        uploadUrl?: string;
        foldersUrl?: string;
        /** Where to 302 the user when their cookie is missing. Optional —
         *  if absent, Companion renders a static error page. */
        loginUrl?: string;
    };
    // ... rest unchanged
```

- [ ] **Step 1.2: Add `rootDomain` and `public.loginUrl` to the runtime `Brand` interface**

In the same file, modify the `Brand` interface. Find the existing `public` block and the field block following `auth`, add:

```ts
export interface Brand {
    id: string;
    displayName: string;
    /** Brand's registrable domain (e.g. "abeduls.com"). null when auth.url is null. */
    rootDomain: string | null;
    companionUrl?: string;
    auth: { /* unchanged */ };
    s3: BrandS3Config;
    providers: { /* unchanged */ };
    corsOrigins: (string | RegExp)[];
    uploadUrls: string[];
    secret: string;
    public: {
        backendUrl: string;
        uploadUrl: string;
        foldersUrl?: string;
        /** Where Companion 302's the user when their cookie is missing. */
        loginUrl?: string;
    };
    server: { /* unchanged */ };
    filePath: string;
    enabledPlugins: string[];
}
```

- [ ] **Step 1.3: Add Zod schema fields and `superRefine` cross-field validation**

In `src/modules/brand/brand.schema.ts`, modify `brandConfigSchema`. Find the existing `displayName` line, add `rootDomain` after it. Find the `public` object, add `loginUrl`. Append `.superRefine(...)` after the closing `.strict()`:

```ts
export const brandConfigSchema = z.object({
    displayName: z.string().min(1).optional(),
    rootDomain: z.string()
        .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, 'Must be a registrable domain like "midomain.com"')
        .optional(),
    auth: z.object({
        url: z.string().min(1).optional(),
        cookieName: z.string().min(1).optional(),
    }).strict().optional(),
    public: z.object({
        backendUrl: z.string().min(1).optional(),
        uploadUrl: z.string().min(1).optional(),
        foldersUrl: z.string().min(1).optional(),
        loginUrl: z.string().url().optional(),
    }).strict().optional(),
    authUrl: z.string().min(1).optional(),
    authCookieName: z.string().min(1).optional(),
    publicBackendUrl: z.string().min(1).optional(),
    publicUploadUrl: z.string().min(1).optional(),
    companionUrl: z.string().min(1).optional(),
    corsOrigins: z.array(z.string().min(1)).optional(),
    uploadUrls: z.array(z.string().min(1)).optional(),
    s3: s3ConfigSchema.optional(),
    providers: z.object({
        google: googleProviderConfigSchema.optional(),
        dropbox: providerConfigSchema.optional(),
        facebook: providerConfigSchema.optional(),
        instagram: providerConfigSchema.optional(),
        onedrive: providerConfigSchema.optional(),
        box: providerConfigSchema.optional(),
        unsplash: providerConfigSchema.optional(),
        zoom: providerConfigSchema.optional(),
    }).strict().optional(),
    enabledPlugins: z.string().min(1).optional(),
}).strict()
.superRefine((cfg, ctx) => {
    // Cross-field invariant: a brand with auth.url MUST declare rootDomain so
    // Companion can derive CORS scope and the cookie domain expectation.
    const hasAuth = !!(cfg.auth?.url ?? cfg.authUrl);
    if (hasAuth && !cfg.rootDomain) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rootDomain'],
            message: 'rootDomain is required when auth.url is configured (cookie auth model)',
        });
    }
});
```

- [ ] **Step 1.4: Set `rootDomain` and `public.loginUrl` in `createBrand`**

In `src/modules/brand/brand.service.ts`, modify the `createBrand` function. Find the `return {` block and add `rootDomain` after `displayName`, add `loginUrl` inside the `public` IIFE:

```ts
    return {
        id: slug,
        displayName: config.displayName ?? slug,
        rootDomain: config.rootDomain ?? null,

        companionUrl: config.companionUrl,

        auth: {
            url: config.auth?.url ?? config.authUrl ?? null,
            cookieName: config.auth?.cookieName ?? config.authCookieName ?? 'session',
        },

        s3: createS3Config(config.s3, defaults.s3Defaults),

        providers: { /* unchanged */ },

        corsOrigins: parseCorsOrigins(config.corsOrigins, defaults.corsOrigins),
        uploadUrls: config.uploadUrls ?? ['*'],

        public: (() => {
            const backendUrl = config.public?.backendUrl
                ?? config.publicBackendUrl
                ?? defaults.publicDefaults.backendUrl
                ?? 'http://localhost';

            const uploadUrl = config.public?.uploadUrl
                ?? config.publicUploadUrl
                ?? defaults.publicDefaults.uploadUrl
                ?? `${backendUrl}/api/frame/contents/upload/public`;

            const foldersUrl = config.public?.foldersUrl
                ?? defaults.publicDefaults.foldersUrl;

            const loginUrl = config.public?.loginUrl;

            return {
                backendUrl,
                uploadUrl,
                foldersUrl,
                loginUrl,
            };
        })(),

        secret: defaults.secret,
        server: { /* unchanged */ },
        filePath: defaults.filePath,
        enabledPlugins: parseEnabledPlugins(config.enabledPlugins),
    };
};
```

**Important: do NOT add anything to `brand.corsOrigins`.** The CORS regex lives in `core/cors.ts` (Task 2). `brand.rootDomain` is the single source of truth — `corsForBrand` reads it.

- [ ] **Step 1.5: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS (no output from `tsc --noEmit`).

- [ ] **Step 1.6: Manual smoke test — schema rejects bad config**

Create a temporary test brand JSON missing `rootDomain` to confirm the `superRefine` fires.

```bash
# Add a temp invalid brand to .env (or use existing brand temporarily) and run:
COMPANION_BRANDS=test-bad COMPANION_SECRET=12345678901234567 \
  TEST_BAD='{"auth":{"url":"https://example.com/api/user"}}' \
  npx tsx -e "import('./src/modules/brand/brand.schema.js').then(m => console.log(m.brandConfigSchema.safeParse(JSON.parse(process.env.TEST_BAD)).error?.format()))"
```

Expected: error output mentioning `rootDomain is required when auth.url is configured`.

- [ ] **Step 1.7: Commit**

```bash
git add src/modules/brand/brand.types.ts src/modules/brand/brand.schema.ts src/modules/brand/brand.service.ts
git commit -m "feat(brand): add rootDomain and public.loginUrl config fields

Adds two new optional fields to BrandConfigJSON, both surfaced on the
runtime Brand interface. rootDomain is the registrable domain (e.g.
\"abeduls.com\") and is enforced via superRefine: required whenever
auth.url is configured. public.loginUrl is where Companion redirects
unauthenticated users (via Task 3).

createBrand stores rootDomain as a plain string on the Brand object;
no CORS regex synthesis happens here. The regex is constructed at the
consumer (src/core/cors.ts in Task 2) so brand.corsOrigins remains
untouched and the new upload-API CORS policy does not bleed into
Companion's OAuth-flow CORS."
```

---

## Task 2: CORS middleware for `/api/uppy/*`

**Files:**
- Create: `src/core/cors.ts`
- Modify: `src/server.ts`

- [ ] **Step 2.1: Create `src/core/cors.ts`**

```ts
import type { RequestHandler } from 'express';
import type { Brand } from '../modules/brand/brand.types.js';

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (s: string): string => s.replace(REGEX_METACHARS, '\\$&');

/**
 * Per-brand CORS middleware for /api/uppy/* routes.
 *
 * Echoes the request `Origin` when it matches `*.<rootDomain>` with the brand's
 * scheme constraints. In production (envProtocol === 'https') the regex
 * accepts only HTTPS origins — never echo Allow-Credentials to a plain-HTTP
 * page under the brand root, otherwise an attacker on http://anywhere.<root>
 * could read credentialed responses (the Secure cookie still travels because
 * the request URL is HTTPS).
 *
 * In dev (envProtocol === 'http') HTTP is also allowed plus a literal exemption
 * for http://localhost(:port) so the local toolchain works without TLS setup.
 *
 * Returns a no-op middleware when brand.rootDomain is null (auth disabled).
 */
export const corsForBrand = (
    brand: Brand,
    envProtocol: 'http' | 'https',
): RequestHandler => {
    if (!brand.rootDomain) {
        return (_req, _res, next) => next();
    }

    const escaped = escapeRegex(brand.rootDomain);
    const scheme = envProtocol === 'https' ? 'https' : 'https?';
    const rootRegex = new RegExp(
        `^${scheme}://([a-z0-9-]+\\.)+${escaped}(:\\d+)?$`,
        'i',
    );
    const localhostRegex = /^http:\/\/localhost(:\d+)?$/i;

    const isAllowed = (origin: string): boolean => {
        if (rootRegex.test(origin)) return true;
        if (envProtocol === 'http' && localhostRegex.test(origin)) return true;
        return false;
    };

    return (req, res, next) => {
        const origin = req.get('origin');

        // Same-origin or non-CORS request — no headers needed.
        if (!origin) {
            next();
            return;
        }

        if (!isAllowed(origin)) {
            // Origin not in allow-list: do not set CORS headers. The browser
            // will block the response to the JS caller.
            next();
            return;
        }

        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader(
            'Access-Control-Allow-Methods',
            'GET, POST, DELETE, OPTIONS',
        );
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');

        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    };
};
```

- [ ] **Step 2.2: Mount `corsForBrand` in `src/server.ts`**

In `src/server.ts`, add the import and mount the middleware before `apiRouter` in the per-brand loop. Find the existing import block at the top:

```ts
import { attachUser, requireAuth } from './modules/auth/index.js';
```

Add a new line directly below it:

```ts
import { corsForBrand } from './core/cors.js';
```

Then find the per-brand mount loop. Locate the existing line that mounts `apiRouter`:

```ts
        // Mount custom API (S3 signing, etc.)
        app.use(`/${brand.id}/api`, apiRouter);
```

Replace with:

```ts
        // Mount custom API (S3 signing, etc.) behind per-brand CORS.
        // The middleware accepts any *.<rootDomain> origin (HTTPS-only in prod)
        // so dashboards on sibling subdomains can call /api/uppy/* with cookies.
        app.use(`/${brand.id}/api`, corsForBrand(brand, env.protocol), apiRouter);
```

- [ ] **Step 2.3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 2.4: Manual smoke test — preflight returns the expected headers**

Update the local `.env` to give your test brand a `rootDomain` (e.g. add `"rootDomain": "abeduls.com"` to the `ABEDULS` JSON). Start the server:

```bash
pnpm dev
```

In another terminal, simulate a cross-origin preflight:

```bash
curl -i -X OPTIONS http://localhost:3020/abeduls/api/uppy/sign-s3 \
  -H "Origin: https://dashboard.abeduls.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type"
```

Expected response status `204` with these headers (exact values may differ in casing):

```
Access-Control-Allow-Origin: https://dashboard.abeduls.com
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 600
Vary: Origin
```

Now test a disallowed origin:

```bash
curl -i -X OPTIONS http://localhost:3020/abeduls/api/uppy/sign-s3 \
  -H "Origin: https://evil.com" \
  -H "Access-Control-Request-Method: POST"
```

Expected: response **without** any `Access-Control-*` headers. (Status will be 401 or 404 depending on what the request hits — that is fine; the absence of CORS headers is what we are verifying.)

Stop the dev server (`Ctrl-C`).

- [ ] **Step 2.5: Commit**

```bash
git add src/core/cors.ts src/server.ts
git commit -m "feat(cors): per-brand CORS middleware for /api/uppy/*

corsForBrand(brand, envProtocol) echoes the request Origin when it
matches *.<rootDomain>. In production (envProtocol='https') only HTTPS
origins are accepted; in dev HTTP is also allowed plus http://localhost.

The preflight response sets Allow-Methods: GET, POST, DELETE, OPTIONS
(DELETE is required for abortMultipartUpload — without it browsers
block the actual request) and Allow-Headers: Content-Type. Max-Age 600
keeps preflight chatter low during multipart uploads.

The middleware is mounted on /\${brand.id}/api before apiRouter. When
brand.rootDomain is null (auth disabled), corsForBrand returns a no-op
so the brand keeps working same-origin only."
```

---

## Task 3: Rewrite `serveUppyPage` (cookie-only + redirect-to-login + no-store)

**Files:**
- Modify: `src/modules/companion/uppy.routes.ts`

- [ ] **Step 3.1: Add the `redirectToLoginOrShowError` helper**

In `src/modules/companion/uppy.routes.ts`, add the helper above the `serveUppyPage` export. Find the closing `};` of `generateErrorPage` and insert the helper directly below it:

```ts
/**
 * When the brand session cookie is missing or invalid, redirect the user to
 * the brand's login page (with a `?redirect=` back to /uppy) if configured;
 * otherwise render a static 401 page with manual login instructions.
 */
const redirectToLoginOrShowError = (
    req: AppRequest,
    res: Response,
    brand: Brand,
): void => {
    if (brand.public.loginUrl) {
        const companionPublicUrl = brand.companionUrl
            ?? `${brand.server.protocol}://${brand.server.host}`;
        const fullCurrentUrl = new URL(req.originalUrl, companionPublicUrl).toString();

        const loginUrl = new URL(brand.public.loginUrl);
        loginUrl.searchParams.set('redirect', fullCurrentUrl);
        res.redirect(302, loginUrl.toString());
        return;
    }

    res.status(401).send(generateErrorPage(
        'Session Expired',
        'Your session has expired or you are not logged in. Please log in via the dashboard and try again.',
    ));
};
```

- [ ] **Step 3.2: Harden the inline-script escape helpers**

The current `toJsStringLiteral` in this file does NOT escape `</script>`-style tag-breaks or U+2028/U+2029 line separators, both of which can break out of the surrounding `<script>` block when injected with attacker-controlled data. `JSON.stringify(folders)` has the same problem. Folder names come from the brand backend — even if that backend is trusted, defense-in-depth requires neutralizing these characters before HTML injection.

Find the existing helper at the top of the file:

```ts
const toJsStringLiteral = (value: string | undefined | null): string => {
    const str = value ?? '';
    const escaped = str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'${escaped}'`;
};
```

Replace with:

```ts
/**
 * Escapes a value so it can appear safely inside a single-quoted JS string
 * literal embedded in an HTML <script> tag. Beyond the obvious quote/backslash
 * escapes, this also neutralizes:
 *   - `</` (and `<!--`/`-->`) — would otherwise let a value close the script
 *     tag or open an HTML comment that survives the `</script>` boundary.
 *   - U+2028 / U+2029 — JS treats these as line terminators, so an unescaped
 *     occurrence inside a string literal raises SyntaxError or breaks parsing.
 */
const toJsStringLiteral = (value: string | undefined | null): string => {
    const str = value ?? '';
    const escaped = str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/<\//g, '<\\/')
        .replace(/<!--/g, '<\\!--')
        .replace(/-->/g, '--\\>')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return `'${escaped}'`;
};

/**
 * Serializes data to JSON suitable for inline embedding in an HTML <script>.
 * Standard JSON.stringify can produce `</` (closing the script tag) or
 * U+2028/U+2029 (which JS parses as line terminators). Both are escaped here.
 * Output is still valid JSON parseable by the browser's JS engine.
 */
const safeJsonForHtmlScript = (data: unknown): string => {
    return JSON.stringify(data)
        .replace(/<\//g, '<\\/')
        .replace(/<!--/g, '<\\!--')
        .replace(/-->/g, '--\\>')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
};
```

The new `toJsStringLiteral` is a strict superset of the old one (everything the old one escaped, the new one still escapes). All existing call sites continue to work without changes.

- [ ] **Step 3.3: Rewrite `serveUppyPage` body**

Replace the entire body of `serveUppyPage` (from `const brand = req.brand;` through to the final `res.send(html);`) with the cookie-only version. Find the existing block from line ~127 onward and replace with:

```ts
export const serveUppyPage = async (
    req: AppRequest,
    res: Response,
    _next: NextFunction,
): Promise<void> => {
    const brand = req.brand;

    if (!brand) {
        res.status(400).send('Brand not resolved');
        return;
    }

    // Brands without auth.url cannot receive authenticated uploads.
    if (!brand.auth.url) {
        res.status(403).send(generateErrorPage(
            'Authentication Required',
            'This upload page requires authentication but the brand has no auth URL configured.',
        ));
        return;
    }

    // Cookie-only auth: the browser sends the brand session cookie
    // (Domain=.<rootDomain>) automatically when the user is logged in.
    // No more ?bearerToken= query param, no more BEARER_TOKEN injection.
    const cookieToken = (req.cookies as Record<string, string>)?.[brand.auth.cookieName] ?? null;
    if (!cookieToken) {
        return redirectToLoginOrShowError(req, res, brand);
    }

    const authResult = await authenticate(cookieToken, brand);
    if (!authResult.authenticated || !authResult.user) {
        return redirectToLoginOrShowError(req, res, brand);
    }

    req.user = authResult.user;

    // Folders fetch happens only when we are about to render — saves a
    // round-trip when the request would have redirected.
    const folders = await fetchFolders(cookieToken, brand);

    try {
        const htmlPath = path.join(__dirname, 'uppy.html');
        let html = await fs.readFile(htmlPath, 'utf8');

        const enabledPlugins = getEnabledPlugins(brand);

        const companionUrl = brand.companionUrl
            ? brand.companionUrl
            : `${brand.server.protocol}://${brand.server.host}${brand.server.path}`;

        // Replace placeholders. BEARER_TOKEN_VALUE is intentionally absent:
        // the page no longer carries the token in any form.
        html = html.replace(/BRAND_SLUG_VALUE/g, toJsStringLiteral(brand.id));
        html = html.replace(/BRAND_NAME_VALUE/g, toJsStringLiteral(brand.displayName));
        html = html.replace(/BRAND_LOGO_URL_VALUE/g, toJsStringLiteral(''));
        html = html.replace(/BRAND_USER_ENDPOINT_VALUE/g, toJsStringLiteral(brand.auth.url ?? ''));
        html = html.replace(/COMPANION_URL_VALUE/g, toJsStringLiteral(companionUrl));
        html = html.replace(/SERVER_URL_VALUE/g, toJsStringLiteral(`/${brand.id}`));
        html = html.replace(/PUBLIC_BACKEND_URL_VALUE/g, toJsStringLiteral(brand.public.backendUrl));
        html = html.replace(/PUBLIC_UPLOAD_URL_VALUE/g, toJsStringLiteral(brand.public.uploadUrl));
        html = html.replace(/GOOGLE_API_KEY_DRIVE_VALUE/g, toJsStringLiteral(brand.providers.google?.driveApiKey ?? ''));
        html = html.replace(/GOOGLE_API_KEY_PHOTOS_VALUE/g, toJsStringLiteral(brand.providers.google?.photosApiKey ?? ''));
        html = html.replace(/GOOGLE_CLIENT_ID_VALUE/g, toJsStringLiteral(brand.providers.google?.clientId ?? ''));
        html = html.replace(/GOOGLE_APP_ID_VALUE/g, toJsStringLiteral(brand.providers.google?.appId ?? ''));
        // Use safeJsonForHtmlScript (NOT raw JSON.stringify) for any inline
        // JSON injection. Folder names come from the brand backend; without
        // escaping `</`, `<!--`, `-->`, U+2028 and U+2029 a malicious or
        // corrupted value would break out of the surrounding <script> tag.
        html = html.replace(/FOLDERS_DATA_VALUE/g, safeJsonForHtmlScript(folders));
        html = html.replace(/ENABLED_PLUGINS_VALUE/g, safeJsonForHtmlScript(enabledPlugins));

        // Authenticated, per-user document — never cached (OWASP recommendation).
        res.set('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error(`[uppy] Error serving page for brand "${brand.id}":`, error);
        res.status(500).send('Error loading upload page');
    }
};
```

- [ ] **Step 3.3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3.4: Manual smoke test — no cookie redirects to loginUrl**

Make sure your local brand has both `rootDomain` and `loginUrl` in its JSON config.

```bash
pnpm dev
```

In another terminal, simulate a request without a cookie:

```bash
curl -i http://localhost:3020/abeduls/uppy
```

Expected: HTTP `302` with a `Location` header pointing at `<loginUrl>?redirect=http%3A%2F%2Flocalhost%3A3020%2Fabeduls%2Fuppy` (or the configured public URL).

Now temporarily remove `loginUrl` from the brand JSON and repeat:

Expected: HTTP `401` with the static `Session Expired` HTML page.

Restore the `loginUrl` config.

- [ ] **Step 3.5: Manual smoke test — valid cookie renders without bearer literal**

With the brand config restored, simulate a valid session cookie. (Use a known valid token from the dashboard.) Replace `<TOKEN>` below:

```bash
curl -i --cookie "session=<TOKEN>" http://localhost:3020/abeduls/uppy
```

Expected: HTTP `200` with `Cache-Control: no-store` in the response headers, and the body **must not** contain the literal token value or the string `BEARER_TOKEN_VALUE`. Verify with:

```bash
curl -s --cookie "session=<TOKEN>" http://localhost:3020/abeduls/uppy | grep -E "BEARER_TOKEN|<TOKEN>"
```

Expected: no matches.

Stop the dev server.

- [ ] **Step 3.6: Commit**

```bash
git add src/modules/companion/uppy.routes.ts
git commit -m "refactor(uppy.routes): cookie-only serveUppyPage, drop bearer injection

Removes the queryToken extraction, the res.cookie() exchange, the 302
redirect-after-validation block, and the BEARER_TOKEN_VALUE HTML
placeholder replacement. The page now reads only the brand session
cookie (which the browser sends automatically because it is scoped to
Domain=.<rootDomain>).

Adds redirectToLoginOrShowError: when the cookie is missing or
invalid, 302s to brand.public.loginUrl with ?redirect=<full url>; if
loginUrl is unset, renders the existing 401 page.

Sets Cache-Control: no-store on the HTML response. The page renders
authenticated per-user data (folders, brand info) — must not be
retained by shared proxies or browser back/forward."
```

---

## Task 4: Remove `BEARER_TOKEN_VALUE` from `uppy.html`

**Files:**
- Modify: `src/modules/companion/uppy.html`

- [ ] **Step 4.1: Remove the bearer token literal from the JS module**

In `src/modules/companion/uppy.html`, find the `<script type="module">` block. Remove the `bearerToken` line and the `bearerToken: bearerToken,` field passed to `uppyModal`. Locate the existing block:

```html
        // Server-injected values (replaced at runtime)
        const bearerToken = BEARER_TOKEN_VALUE ? BEARER_TOKEN_VALUE : '';
        const serverUrl = SERVER_URL_VALUE || 'http://localhost:3000';
```

Replace with (delete the bearerToken line):

```html
        // Server-injected values (replaced at runtime)
        const serverUrl = SERVER_URL_VALUE || 'http://localhost:3000';
```

Then locate the `uppyModal({...})` call:

```html
        // Initialize Uppy
        const uppy = uppyModal({
            bearerToken: bearerToken,
            inline: true,
```

Replace with (delete the bearerToken line):

```html
        // Initialize Uppy
        const uppy = uppyModal({
            inline: true,
```

- [ ] **Step 4.2: Verify no `BEARER_TOKEN` references remain in the HTML**

```bash
grep -n "BEARER_TOKEN\|bearerToken" src/modules/companion/uppy.html
```

Expected: no output (exit code 1).

- [ ] **Step 4.3: Run build to confirm uppy.html copies cleanly**

```bash
pnpm build
```

Expected: PASS, output ends with `[build-assets] dist/modules/companion/{uppyModal.js,uppy.html}`.

```bash
grep -n "BEARER_TOKEN\|bearerToken" dist/modules/companion/uppy.html
```

Expected: no output.

- [ ] **Step 4.4: Commit**

```bash
git add src/modules/companion/uppy.html
git commit -m "refactor(uppy.html): drop BEARER_TOKEN_VALUE injection

The page no longer reads a bearer token literal — auth flows entirely
through the brand session cookie sent by the browser. Removes the
\`const bearerToken = BEARER_TOKEN_VALUE\` line and the matching
\`bearerToken\` field from the uppyModal({...}) initializer."
```

---

## Task 5: Cleanup `uppyModal.ts` (drop bearer header, use `credentials: 'include'`)

**Files:**
- Modify: `src/modules/companion/uppyModal.ts`

- [ ] **Step 5.1: Remove `bearerToken` from `UppyModalOptions`**

In `src/modules/companion/uppyModal.ts`, find the `UppyModalOptions` interface (the public input shape, declared with `export interface UppyModalOptions`). The `bearerToken` field is at line 45 today:

```ts
export interface UppyModalOptions {
    // ... other fields
    GOOGLE_APP_ID?: string | null;
    bearerToken?: string | null;       // ← DELETE this line
    callbackFn?: (result: any) => void;
    // ... rest unchanged
}
```

Delete the `bearerToken?: string | null;` line. Do not modify any other field.

- [ ] **Step 5.2: Replace the bearer-header machinery with `credentials: 'include'`**

Find the existing block (around lines 123-131):

```ts
    const BEARER_TOKEN = readOption(merged, 'bearerToken', null);

    const authHeaders = BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {};
    const mergeHeaders = (headers: Record<string, string> = {}) => ({ ...headers, ...authHeaders });

    const fetchWithAuth = (url: string, options: RequestInit = {}) => {
        const headers = mergeHeaders(options.headers as Record<string, string>);
        return fetch(url, { ...options, headers });
    };
```

Replace with:

```ts
    // Auth travels via the brand session cookie at Domain=.<rootDomain>.
    // The browser sends it automatically with credentials: 'include' on
    // both same-origin (/api/uppy/*) and cross-origin (publicUploadUrl)
    // requests, since they all share the brand registrable domain.
    const fetchWithAuth = (url: string, options: RequestInit = {}) =>
        fetch(url, { ...options, credentials: 'include' });
```

- [ ] **Step 5.3: Verify no leftover `BEARER_TOKEN` or `authHeaders` references**

```bash
grep -n "BEARER_TOKEN\|authHeaders\|mergeHeaders\|bearerToken" src/modules/companion/uppyModal.ts
```

Expected: no output.

- [ ] **Step 5.4: Verify the `fetchWithAuth` callsites still typecheck**

There are seven `fetchWithAuth(...)` callsites in this file. They were calling with the implicit Authorization header — now they get `credentials: 'include'` instead. The signature did not change.

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5.5: Update `auth.service.ts` JSDoc to drop the stale `/uppy` exchange reference**

Open `src/modules/auth/auth.service.ts`. Find the JSDoc above `extractToken`, which currently includes:

```ts
/**
 * Extracts the authentication token from a request.
 *
 * Order: `Authorization: Bearer …` header > brand-specific cookie.
 *
 * The legacy `?bearerToken=` query param is intentionally NOT honored here
 * — query strings get logged by proxies/CDNs/browser history and leak via
 * Referer (OWASP ASVS V8.3.1). The /uppy page exchanges a query token for an
 * HttpOnly cookie via a 302 redirect; everything else must use header or cookie.
 */
```

Replace with:

```ts
/**
 * Extracts the authentication token from a request.
 *
 * Order: `Authorization: Bearer …` header > brand-specific cookie.
 *
 * Query-string tokens are NOT honored anywhere. Tokens in URL params leak
 * into proxy/CDN access logs, browser history, and Referer headers (OWASP
 * ASVS V8.3.1). The brand session cookie at `Domain=.<rootDomain>`, set by
 * the brand backend at login, is the canonical credential. The Authorization
 * header path remains valid for server-to-server callers.
 */
```

The function body (`extractToken` itself) is unchanged.

The wording deliberately says "query-string tokens" rather than naming the legacy `bearerToken` parameter — this lets the verification grep in Step 5.6 / Step 8.1 confirm zero `bearerToken` references in the source tree (a stronger invariant than "the legacy name is acknowledged in a comment").

- [ ] **Step 5.6: Verify no `bearerToken` references survive in the `src/` tree**

```bash
grep -rn "bearerToken" src/
```

Expected: no matches at all.

- [ ] **Step 5.7: Confirm the build still produces uppyModal.js**

```bash
pnpm build
```

Expected: PASS, output ends with `[build-assets] dist/modules/companion/{uppyModal.js,uppy.html}`.

Inspect the compiled output to confirm the bearer string is gone:

```bash
grep -n "BEARER_TOKEN\|authHeaders\|Bearer " dist/modules/companion/uppyModal.js
```

Expected: no output. (`Bearer ` with a trailing space — the literal that would appear in `Authorization: Bearer ...`.)

- [ ] **Step 5.8: Commit**

```bash
git add src/modules/companion/uppyModal.ts src/modules/auth/auth.service.ts
git commit -m "refactor: drop bearerToken from browser flow + sync extractToken JSDoc

uppyModal.ts: removed the bearerToken option from UppyModalOptions, the
BEARER_TOKEN/authHeaders/mergeHeaders machinery, and replaced fetchWithAuth
with a one-line wrapper that sets credentials: 'include' on every call.
The brand session cookie at Domain=.<rootDomain> (set by the brand backend,
never by Companion) authenticates every request automatically — same-origin
calls to /api/uppy/* and cross-origin calls to publicUploadUrl alike.

auth.service.ts: updated extractToken JSDoc. Removed the stale reference
to the /uppy query-token-to-cookie exchange (which Task 3 deleted).
Function body unchanged: bearer header > cookie remains the priority."
```

---

## Task 6: Update `verify-brand-config.ts`

**Files:**
- Modify: `scripts/verify-brand-config.ts`

- [ ] **Step 6.1: Read the current state of the script**

The script currently iterates brands and reports per-brand issues. Open `scripts/verify-brand-config.ts` and locate the per-brand printing block.

- [ ] **Step 6.2: Add `rootDomain` and `loginUrl` checks**

In `scripts/verify-brand-config.ts`, find the per-brand loop body (starts with `console.log(\`[Brand: ${brand.id}]\`);`). Inside it, after the existing `Auth URL` and `Public Backend` lines, insert:

```ts
            console.log(`  - Root domain: ${brand.rootDomain ?? '(not set)'}`);
            console.log(`  - Login URL: ${brand.public.loginUrl ?? '(not set)'}`);

            // rootDomain is only required when auth.url is set. Mirror the
            // brandConfigSchema superRefine invariant so deploy fails early.
            if (brand.auth.url && !brand.rootDomain) {
                console.error(`  ❌ Brand "${brand.id}" has auth.url but no rootDomain — uploads will be rejected at startup.`);
                process.exitCode = 1;
            }

            // loginUrl is optional but strongly recommended; without it,
            // unauthenticated /uppy hits get a static error page rather than
            // a redirect to the dashboard.
            if (brand.auth.url && !brand.public.loginUrl) {
                console.warn(`  ⚠️  Brand "${brand.id}" has no public.loginUrl — unauthenticated /uppy will show a static 401 page instead of redirecting to login.`);
            }
```

- [ ] **Step 6.3: Run the script against the local config**

```bash
npx tsx scripts/verify-brand-config.ts
```

Expected: lists each brand with `Root domain:` and `Login URL:` lines. If your local brand has `rootDomain` set (per Task 2's smoke test setup), no error is printed.

- [ ] **Step 6.4: Run the script with a deliberately broken config**

Temporarily remove `rootDomain` from a brand's JSON (in `.env`) and re-run:

```bash
npx tsx scripts/verify-brand-config.ts
```

Expected: an error line `❌ Brand "..." has auth.url but no rootDomain ...`. Note that `process.exitCode` will be 1.

Restore the `rootDomain` field afterwards.

- [ ] **Step 6.5: Commit**

```bash
git add scripts/verify-brand-config.ts
git commit -m "feat(verify-brand-config): assert rootDomain, warn on missing loginUrl

Adds two new per-brand checks mirroring the brandConfigSchema invariants:
- Error (exit 1) when auth.url is set but rootDomain is not. This is
  the same condition the Zod superRefine catches at startup, but
  surfaced by the verify script for pre-deploy CI gates.
- Warning when auth.url is set but public.loginUrl is missing. The
  brand will boot, but unauthenticated /uppy hits show a static 401
  rather than a 302 to login."
```

---

## Task 7: Documentation updates

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 7.1: Add `rootDomain` and `loginUrl` to `.env.example` brand template**

In `.env.example`, find the brand JSON template (the `BRAND_NAME='{...}'` example block in the comments). Locate the `"public"` block within and update the template. Find:

```
# ABEDULS='{
#   "auth": {
#     "url": "...",
#     "cookieName": "..."
#   },
#   "public": {
#     "backendUrl": "...",
#     "uploadUrl": "...",
#     "foldersUrl": "..."
#   },
```

Replace with:

```
# ABEDULS='{
#   "rootDomain": "abeduls.com",
#   "auth": {
#     "url": "...",
#     "cookieName": "..."
#   },
#   "public": {
#     "backendUrl": "...",
#     "uploadUrl": "...",
#     "foldersUrl": "...",
#     "loginUrl": "https://dashboard.abeduls.com/login"
#   },
```

If the template uses a different brand name, adapt accordingly. The two new fields are at the same indentation as the others.

After the example, add a new comment block explaining the two fields AND the operator-side prerequisites (matching spec §8). Do not paraphrase loosely — operators rely on this checklist to avoid breaking uploads or reintroducing the HTTP-credentialed-CORS vulnerability the design closes:

```
# ===========================================
# rootDomain & public.loginUrl (cookie auth)
# ===========================================
# rootDomain: Required when auth.url is set. The registrable domain
# the brand backend issues its session cookie under (Domain=.<rootDomain>).
# Companion uses this to (a) build the per-brand CORS allowlist for
# /api/uppy/* (any *.<rootDomain> origin is allowed in production
# over HTTPS only) and (b) document the cookie scope expectation.
#
# public.loginUrl: Optional. Where Companion 302's the user when the
# brand session cookie is missing or invalid. Receives ?redirect=<full
# url> back to /uppy. The dashboard MUST validate the redirect target
# against an allow-list (e.g. only redirect to https://companion.<root>)
# to avoid open-redirect abuse.
#
# ===========================================
# OPERATOR PRE-DEPLOY CHECKLIST (do these BEFORE rolling this version)
# ===========================================
# 1. Brand backend session cookie must be set with:
#      Domain=.<rootDomain>   (e.g. Domain=.abeduls.com)
#      HttpOnly
#      Secure (in production)
#      SameSite=Lax
#    Laravel example: config/session.php
#      'domain' => '.abeduls.com',
#      'secure' => true,
#      'http_only' => true,
#      'same_site' => 'lax',
#    Verify with: curl -i https://api.<rootDomain>/login -d ...
#    and inspect the Set-Cookie header.
#
# 2. CORS on every brand backend endpoint the Uppy page calls
#    cross-origin (currently publicUploadUrl; foldersUrl is server-to-server
#    from Companion and does not need CORS):
#      Access-Control-Allow-Origin: <echo request Origin if it matches
#                                    https://*.<rootDomain> in production;
#                                    http:// allowed only for explicit
#                                    local/dev origins>
#      Access-Control-Allow-Credentials: true
#      Access-Control-Allow-Methods: GET, POST, OPTIONS
#      Access-Control-Allow-Headers: Content-Type
#      OPTIONS preflight returns 204 (or 200) with the headers above.
#
#    DO NOT echo http:// origins in production. The brand session cookie has
#    Secure and travels because the request URL is HTTPS, so allowing an
#    http:// origin under the brand root with Allow-Credentials would let an
#    HTTP attacker page read credentialed responses — the same vulnerability
#    Companion's CORS rule closes on the upload-API side.
#
# 3. Dashboard's loginUrl endpoint must accept ?redirect=<url> and validate
#    the redirect target against an allow-list (e.g. only redirect to URLs
#    starting with https://companion.<rootDomain>) to prevent open-redirect
#    abuse. This is the dashboard's responsibility — Companion only constructs
#    the URL; it does not validate.
#
# 4. Run before deploy:
#      npx tsx scripts/verify-brand-config.ts
#    Must exit 0. Will fail if any brand has auth.url without rootDomain.
#
# Full design rationale: docs/superpowers/specs/2026-04-29-cookie-only-cross-origin-auth-design.md
```

- [ ] **Step 7.2: Update `CLAUDE.md` auth-flow gotcha**

Open `CLAUDE.md`. Find the gotcha line that describes the current auth flow (from the previous audit pass — references `extractToken`, `?bearerToken=` on `/uppy`, the HttpOnly cookie set on the redirect). Replace it with the cookie-only model.

Find:

```
- `src/modules/auth/` — `extractToken` priority is **`Authorization: Bearer` header → cookie `brand.auth.cookieName`**. The `?bearerToken=` query param is intentionally NOT honored by `extractToken` ... The `/uppy` page is the one place that still accepts `?bearerToken=`: it validates, sets an HttpOnly cookie, and 302-redirects to a URL stripped of the query param. ...
```

Replace with:

```
- `src/modules/auth/` — `extractToken` priority is **`Authorization: Bearer` header → cookie `brand.auth.cookieName`**. The `?bearerToken=` query param is NOT honored anywhere — auth flows exclusively through the cookie. The cookie is set by the **brand backend** at `Domain=.<rootDomain>` (configured via `brand.rootDomain`), so the browser sends it automatically to all subdomains under the brand root: same-origin to Companion, and cross-origin to `publicUploadUrl` via `credentials: 'include'`. Companion never sets cookies on the brand domain — it only consumes them. When the cookie is missing or invalid on `/uppy`, Companion 302s to `brand.public.loginUrl?redirect=<full url>` (or renders a static 401 page if `loginUrl` is unset). `requireAuth` on `/api/uppy/*` returns 401 in the same scenario for API callers.

- **Per-brand CORS** (`src/core/cors.ts`): `/api/uppy/*` is wrapped in `corsForBrand(brand, env.protocol)` which echoes any matching `*.<rootDomain>` origin with `Access-Control-Allow-Credentials: true`. In production (`env.protocol === 'https'`) only HTTPS origins are echoed — never echo Allow-Credentials to a plain-HTTP origin under the brand root, otherwise a page on `http://anywhere.<rootDomain>` could read credentialed responses (the `Secure` cookie still travels because the request URL is HTTPS). Browser-side, all `/uppy` page fetches use `credentials: 'include'`; no `Authorization: Bearer` header is sent.
```

If the existing gotcha block has a slightly different shape, adapt: the goal is to replace the previous bearer-token-flow description with the cookie-only model + new per-brand CORS gotcha.

- [ ] **Step 7.3: Run typecheck and build to confirm nothing else regressed**

```bash
pnpm typecheck && pnpm build
```

Expected: both PASS.

- [ ] **Step 7.4: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: cookie-only auth flow in .env.example and CLAUDE.md

.env.example: documents rootDomain (required when auth.url is set) and
public.loginUrl (optional 302 target for missing/invalid cookies) in
the brand JSON template, plus a section explaining their roles.

CLAUDE.md: replaces the previous bearer-token-flow gotcha with the
cookie-only model. New gotcha covers per-brand CORS via core/cors.ts
and the production-HTTPS-only constraint."
```

---

## Task 8: End-to-end smoke test (no commit, just verification)

This task is a final validation against the spec's §10 testing plan. No code changes — confirms the previous tasks integrate correctly.

**Files:** none.

- [ ] **Step 8.1: Confirm there is zero leftover bearer-token machinery**

```bash
grep -rn "BEARER_TOKEN" src/ scripts/
grep -rn "bearerToken" src/ scripts/ | grep -v "Bearer "
```

Expected: no output from either command.

The second command is filtered: the literal string `Bearer ` (with trailing space) is allowed because it appears in `extractToken` for the `Authorization: Bearer …` header parsing — that path remains valid for server-to-server callers.

- [ ] **Step 8.2: Confirm typecheck + build are green from scratch**

```bash
rm -rf dist
pnpm typecheck
pnpm build
ls -la dist/modules/companion/
```

Expected:
- `pnpm typecheck` PASSES.
- `pnpm build` PASSES.
- `dist/modules/companion/` contains `uppyModal.js` and `uppy.html`.

- [ ] **Step 8.3: Run the full set of manual smoke scenarios from the spec §10.1**

Start the server with a brand that has `rootDomain` and `loginUrl` configured:

```bash
pnpm dev
```

Run each scenario in sequence and check off the corresponding row:

| # | Scenario | Command | Expected |
|---|----------|---------|----------|
| a | Cookie-less request to `/uppy` with `loginUrl` configured | `curl -i http://localhost:3020/abeduls/uppy` | 302 to `<loginUrl>?redirect=...`. |
| b | Cookie-less request with `loginUrl` unset (temporarily) | curl as in (a) after removing `loginUrl` from `.env` | 401 with the static error page. Restore `loginUrl` after. |
| c | Authenticated request renders without bearer literal | `curl -s --cookie "session=<TOKEN>" http://localhost:3020/abeduls/uppy \| grep -E "BEARER\|<TOKEN>"` | No matches. |
| d | Authenticated response has `Cache-Control: no-store` | `curl -I --cookie "session=<TOKEN>" http://localhost:3020/abeduls/uppy` | `Cache-Control: no-store` in headers. |
| e | Cross-origin preflight from a same-root origin | `curl -i -X OPTIONS http://localhost:3020/abeduls/api/uppy/sign-s3 -H "Origin: https://dashboard.abeduls.com" -H "Access-Control-Request-Method: POST"` | 204 with `Access-Control-Allow-Origin: https://dashboard.abeduls.com`. |
| f | Cross-origin preflight from a foreign origin | as in (e) but `-H "Origin: https://evil.com"` | Response WITHOUT any `Access-Control-Allow-*` header. |
| g | Brand JSON with `auth.url` but missing `rootDomain` fails startup | Edit `.env`, remove `rootDomain` from brand JSON, restart server | Server fails with Zod error mentioning `rootDomain is required when auth.url is configured`. Restore `rootDomain` and restart. |

- [ ] **Step 8.4: Browser smoke test (final user-facing verification)**

Open the brand's dashboard in a browser, log in, navigate to the upload page (which should redirect to `companion.<rootDomain>/<brand>/uppy`). Confirm:

1. Page renders normally.
2. **View page source** (Ctrl-U) — search the source for any token-shaped string. There should be none.
3. **DevTools → Application → Cookies**: the brand session cookie is `HttpOnly` and `Secure` (in production).
4. **DevTools → Network**: requests to `/api/uppy/*` show `Cookie: ...` header but **no** `Authorization` header. The cookie travels.
5. Upload a small file end-to-end. Confirm the upload completes and the call to `publicUploadUrl` (cross-origin) succeeds with status 2xx.

Stop the dev server.

- [ ] **Step 8.5: Push branch and open PR**

```bash
git push -u origin feat/cookie-only-auth
gh pr create --base main --head feat/cookie-only-auth \
  --title "feat: cookie-only cross-origin upload auth (closes DEBT_TECH #4 Option A)" \
  --body-file docs/superpowers/specs/2026-04-29-cookie-only-cross-origin-auth-design.md
```

The PR body uses the spec doc as its description so reviewers see the full design context.

---

## Self-review checklist (run after completing all tasks)

- [ ] Spec §1 (problem statement): bearer in HTML eliminated. Verified by Step 8.1.
- [ ] Spec §2 (goals): all goals met. `rootDomain` required, `loginUrl` optional, hard-cut, CORS `*.<rootDomain>`.
- [ ] Spec §3 (decisions): A1, D2, M1, no-CSRF-tokens, CORS-any-subdomain — all implemented.
- [ ] Spec §4 (architecture): no Companion-set cookies; redirect path on missing cookie.
- [ ] Spec §5 (config schema): `rootDomain` + `loginUrl` in types, schema, service.
- [ ] Spec §6 (server-side): all subsections (6.1–6.7) covered by Tasks 1, 2, 3.
- [ ] Spec §7 (client-side): uppyModal + uppy.html cleaned in Tasks 4, 5.
- [ ] Spec §8 (backend pre-deploy): documented in `.env.example` (Task 7) and the operator follows externally.
- [ ] Spec §9 (threat model): trust boundary documented in CLAUDE.md (Task 7).
- [ ] Spec §10 (testing): all rows in §10.1 covered by Step 8.3 + 8.4.
- [ ] Spec §11 (rollout): branch, PR, and pre-deploy operator checklist all reflected.
- [ ] Spec §12 (out of scope): no work touched the deferred items (Option B, CSP/SRI, etc.).
