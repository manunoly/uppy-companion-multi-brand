# Cookie-only cross-origin upload auth

**Status:** Implemented in PR #4 (`feat/cookie-only-auth`) — pending merge to `main`
**Closes:** `DEBT_TECH.md` #4 (Option A path)
**Branch:** `feat/cookie-only-auth`
**Plan:** `docs/superpowers/plans/2026-04-29-cookie-only-cross-origin-auth.md`

---

## 1. Problem statement

Companion's `/uppy` page injects the user's bearer token into the rendered HTML as a JavaScript literal (`BEARER_TOKEN_VALUE` placeholder → `const bearerToken = '<token>'`). Any XSS in the page can read that literal and exfiltrate the token to an attacker-controlled host. Setting `HttpOnly: true` on the brand auth cookie (done in the audit pass) does **not** mitigate this — the same token value is duplicated in JS scope.

The reason the token lives in JS today: `uppyModal.ts` uses it in `Authorization: Bearer …` headers when calling the brand backend's `publicUploadUrl` (a cross-origin endpoint where the Companion-set cookie does not travel).

This spec eliminates the token from the rendered page by relying on **first-party cookies scoped to the brand's registrable domain** (`Domain=.<rootDomain>`). The browser sends those cookies automatically on cross-subdomain requests when `credentials: 'include'` is set.

## 2. Goal & non-goals

### Goals

- Remove `BEARER_TOKEN_VALUE` from `uppy.html` and the `bearerToken` option from `uppyModal.ts`.
- Authenticate every Companion-mediated request (same-origin or cross-origin) via the brand's session cookie at `Domain=.<rootDomain>`.
- Provide a clean failure path (302 to dashboard login with `?redirect=`) when the cookie is missing.
- Hard-cut migration: no legacy code path supporting bearer-in-URL or bearer-in-HTML.
- CORS on Companion accepts any subdomain of the brand's root domain (`*.<rootDomain>`).

### Non-goals (deferred to `DEBT_TECH.md`)

- Multi-tenant deployments where Companion and the brand backend live on **different registrable domains** — see `DEBT_TECH.md` #4 (Option B: BFF proxy).
- Per-brand feature flag / gradual migration. Hard-cut.
- Explicit CSRF tokens **for cross-site requests**. `SameSite=Lax` blocks attacker pages on different registrable domains from carrying the cookie, which is what OWASP CSRF Cheat Sheet 2024 calls "adequate for most applications". **This does NOT cover same-site sibling subdomain abuse** (e.g. a compromised page on another `*.<rootDomain>` subdomain) — that risk is handled by the operator invariant in §9.0 and noted as future hardening (custom-header CSRF gate) in §9.2.
- Rate limiting on `/api/uppy/*`.
- Content Security Policy and Subresource Integrity hardening of the rendered page.

## 3. Decision log

| # | Decision | Alternatives considered | Why |
|---|----------|-------------------------|-----|
| **A1** | Shared root domain (Companion + brand backend share a registrable domain). | A2: cookie scoped to single subdomain (would force backend reconfig or Companion-set cookies). A3: punt to deploy-time investigation. | User confirmed: "el backend principal crea la cookie que es utilizada por todos los subdominios". A1 is the standard pattern (Stripe `*.stripe.com`, Linear `*.linear.app`, Slack `*.slack.com`). |
| **D2** | Companion only **consumes** cookies; never sets them on the brand domain. Missing cookie → 302 redirect to `loginUrl`. | D1: Companion sets the brand cookie with `Domain=.<rootDomain>` after validating a deeplink token. D3: hybrid. | OWASP separation of concerns: only the auth service issues credentials. D1 expands Companion's trust boundary — if Companion is compromised, attacker can mint cookies for any user with a valid token. D2 keeps Companion as a pure consumer. Industry pattern: Vercel preview deploys, Stripe Connect onboarding, Auth0 SDKs all redirect to the IDP for issuance. |
| **M1** | Hard cut. No legacy code path. Brands not meeting prereqs cannot deploy. | M2: opt-in flag per brand. M3: opt-out flag with sunset. | One brand in production at the time of this design. M2/M3 add code-path duplication that historically becomes permanent. With one brand, prereqs are validated once before deploy. |
| **No explicit CSRF tokens** | `SameSite=Lax` cookie covers **cross-site** CSRF (different registrable domain). **Same-site sibling-subdomain CSRF is NOT covered by the cookie** and is addressed by the operator invariant in §9.0 (no untrusted subdomains under `<rootDomain>`). Future hardening (custom-header gate or explicit subdomain allowlist) tracked in `DEBT_TECH.md` #4. | Double-submit cookies, per-request tokens, custom-header gate. | OWASP CSRF Cheat Sheet 2024 considers `SameSite=Lax` adequate for cross-site CSRF. Adding tokens now would not meaningfully change the same-site sibling risk because a compromised sibling subdomain could read a `XSRF-TOKEN` cookie too (it has the same `Domain=.<rootDomain>`). The right defense for that threat is origin/header-based gating on mutating routes — deferred. |
| **CORS accepts any `*.<rootDomain>`** | Hardcoded allow-list. | Specific origin per route. | User requirement: any subdomain of the brand root must be able to call Companion's `/api/uppy/*` (e.g. an embedded modal in dashboard or admin app). The allowlist is implicit in the registrable-domain match. |

## 4. Architecture

### 4.1 Before (current state)

```
[1] dashboard.midomain.com sets cookie  Domain=.midomain.com (already A1)
                  ↓ user clicks "upload"
[2] dashboard redirects to companion.midomain.com/abeduls/uppy?bearerToken=eyJ...
                  ↓
[3] Companion validates token, sets ITS OWN cookie at /abeduls/, renders HTML
    HTML contains:  const bearerToken = 'eyJ...';   ← XSS-readable
                  ↓
[4] JS calls (with Authorization: Bearer eyJ... header):
      - SAME-ORIGIN  /abeduls/api/uppy/*       (cookie also works, but token in header takes priority)
      - CROSS-ORIGIN api.midomain.com/upload   (cookie does not travel cross-origin without explicit CORS+credentials)
```

XSS reading window/HTML scope steals the bearer → full account takeover until token expires.

### 4.2 After (target)

```
[1] dashboard.midomain.com sets cookie  Domain=.midomain.com  HttpOnly  SameSite=Lax
                  ↓ user navigates (cookie travels automatically — same-site nav)
[2] companion.midomain.com/abeduls/uppy    (no query param, no cookie set by Companion)
                  ↓
[3] Companion reads cookie via brand.auth.cookieName → validates → renders HTML
    HTML contains NO bearer token. NO BEARER_TOKEN_VALUE placeholder.
                  ↓
[4] JS calls (with credentials: 'include', NO Authorization header):
      - SAME-ORIGIN  /abeduls/api/uppy/*       browser sends cookie (same-origin)
      - CROSS-ORIGIN api.midomain.com/upload   browser sends cookie (same registrable domain + Lax + Allow-Credentials)

Failure path: cookie missing → 302 to dashboard.midomain.com/login?redirect=<full url>
```

XSS cannot read what does not exist in JS scope. HttpOnly stops `document.cookie` exfil. Cross-site CSRF blocked by SameSite=Lax.

## 5. Brand configuration changes

### 5.1 New JSON fields

Two new fields in `BrandConfigJSON` (consumed by `brand.schema.ts` Zod validation at startup).

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `rootDomain` | `string` (registrable domain pattern) | **Required if `auth.url` is set** | Single source of truth for the brand's registrable domain. Drives CORS regex and documents the cookie scope expectation. |
| `public.loginUrl` | `string` (URL) | Optional | Where to 302 the user when their cookie is missing. If unset, Companion renders a static error page. |

### 5.2 Cross-field validation

`brandConfigSchema` adds a `superRefine` that fails startup when `auth.url` is set but `rootDomain` is missing:

```ts
.superRefine((cfg, ctx) => {
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

Rationale: a brand with `auth.url` but no `rootDomain` cannot serve uploads — fail loud at startup rather than at the first request.

### 5.3 Where the CORS regex lives

`brand.service.ts` stores `rootDomain` as a plain string on the `Brand` object — no derivation. The regex is constructed at the point of use, in `corsForBrand` (`src/core/cors.ts`, see §6.6). Rationale: keeping `Brand` serializable and avoiding mixing brand-derived `RegExp` with env-derived strings inside `brand.corsOrigins` (which would make the array harder to reason about).

`escapeRegex` is a 4-line helper inlined in `core/cors.ts` that escapes the 12 regex metacharacters (`. * + ? ^ $ { } ( ) | [ ] \`). No external dependency.

### 5.4 Example `.env` brand JSON (post-change)

```env
ABEDULS='{
    "displayName": "Abeduls",
    "rootDomain": "abeduls.com",
    "companionUrl": "https://companion.abeduls.com/abeduls",
    "auth": {
        "url": "https://api.abeduls.com/api/user",
        "cookieName": "session"
    },
    "public": {
        "backendUrl": "https://api.abeduls.com",
        "uploadUrl": "https://api.abeduls.com/api/frame/contents/upload/public",
        "foldersUrl": "/api/folders",
        "loginUrl": "https://dashboard.abeduls.com/login"
    },
    "s3": { ... },
    "providers": { ... }
}'
```

## 6. Server-side changes

### 6.1 `src/modules/brand/brand.types.ts`

Add `rootDomain?: string` to `BrandConfigJSON`. Add `loginUrl?: string` to the `public` block. On the runtime `Brand` interface, add `rootDomain: string | null` and `public.loginUrl?: string`.

### 6.2 `src/modules/brand/brand.schema.ts`

Add `rootDomain` and `public.loginUrl` to the Zod schema. Add the `superRefine` from §5.2.

### 6.3 `src/modules/brand/brand.service.ts`

Set `brand.rootDomain` from config. **No regex synthesis here** — `brand.corsOrigins` is left untouched by the new field. The CORS regex is constructed at the consumer (`src/core/cors.ts`, see §6.6), so the `brand` object remains a plain serializable shape. This also keeps the new upload-API CORS policy (§6.6) from leaking into Companion's OAuth-flow CORS (which is driven by the env-derived `corsOrigins` and remains untouched).

### 6.4 `src/modules/companion/uppy.routes.ts` — `serveUppyPage` rewrite

Remove the `queryToken` extraction, the `res.cookie()` call, the redirect block that exchanges query token for cookie, and the `BEARER_TOKEN_VALUE` HTML placeholder replacement. The handler becomes:

```ts
export const serveUppyPage = async (req, res, _next) => {
    const brand = req.brand;
    if (!brand) { res.status(400).send('Brand not resolved'); return; }
    if (!brand.auth.url) { /* same 403 page as today */ return; }

    const cookieToken = (req.cookies as Record<string, string>)?.[brand.auth.cookieName] ?? null;
    if (!cookieToken) {
        return redirectToLoginOrShowError(req, res, brand);
    }

    const authResult = await authenticate(cookieToken, brand);
    if (!authResult.authenticated || !authResult.user) {
        return redirectToLoginOrShowError(req, res, brand);
    }

    req.user = authResult.user;
    const folders = await fetchFolders(cookieToken, brand);

    // ... HTML render, with BEARER_TOKEN_VALUE replacement REMOVED.

    // Authenticated, per-user document — never cached. Prevents shared
    // proxies and browser back/forward from retaining another user's view.
    res.set('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
};

const redirectToLoginOrShowError = (req: AppRequest, res: Response, brand: Brand): void => {
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
        'Your session has expired or you are not logged in. Please log in via the dashboard and try again.'
    ));
};
```

### 6.5 `src/modules/companion/uppy.html`

Remove the `BEARER_TOKEN_VALUE` placeholder and the `const bearerToken = BEARER_TOKEN_VALUE …` line. The HTML no longer carries a token in any form.

### 6.6 `src/core/cors.ts` (new) and mount in `src/server.ts`

Create a new helper file `src/core/cors.ts` exporting `corsForBrand(brand: Brand, envProtocol: 'http' | 'https'): RequestHandler`. The middleware echoes the request `Origin` when it matches the brand's allowed-origin regex, with `Access-Control-Allow-Credentials: true`. Mount before `apiRouter` in `server.ts`:

```ts
app.use(`/${brand.id}/api`, corsForBrand(brand, env.protocol), apiRouter);
```

**Scheme constraint (security-critical):** the regex scheme is tied to `env.protocol`:

| `env.protocol` | Regex scheme | Rationale |
|---|---|---|
| `'https'` (production) | `^https://([a-z0-9-]+\.)+<rootDomain>(:\d+)?$` — **HTTPS only** | A plain-HTTP page on any `*.<rootDomain>` could otherwise make `credentials: 'include'` requests to the HTTPS Companion API. The `Secure` cookie still travels (the request URL is HTTPS) and CORS would let the HTTP attacker page read the response. **Never echo `Access-Control-Allow-Credentials: true` to an `http://` origin in production.** |
| `'http'` (local dev) | `^https?://([a-z0-9-]+\.)+<rootDomain>(:\d+)?$` plus an explicit allowance for `http://localhost(:port)?` | Local dev tooling typically runs over HTTP; tightening here breaks the inner loop. |

The middleware contract (response headers when origin matches):

| Header | Value | Why |
|---|---|---|
| `Access-Control-Allow-Origin` | echoed request `Origin` | Required for credentialed CORS — `*` is invalid with `Allow-Credentials: true`. |
| `Access-Control-Allow-Credentials` | `true` | Enables cookie travel. |
| `Access-Control-Allow-Methods` | `GET, POST, DELETE, OPTIONS` | These are the methods used by `/api/uppy/*`: `GET` (sign-s3, sign-part, list-parts), `POST` (sign-s3, multipart create, complete), `DELETE` (multipart abort). DELETE always preflights — without explicit allow, browser blocks the actual request. |
| `Access-Control-Allow-Headers` | `Content-Type` | Required for the JSON `POST` bodies; preflight rejects without it. |
| `Access-Control-Max-Age` | `600` | Cache preflight for 10 minutes to avoid OPTIONS storms during multipart uploads. |
| `Vary` | `Origin` | Prevents shared caches from poisoning cross-origin responses. |

Behavior:
- Returns `204` for `OPTIONS` preflight when origin matches (with all headers above).
- Falls through (no headers) when origin is missing (same-origin) or not in the allow-list (browser will block the response).
- Includes an inline `escapeRegex` helper (4-line literal-character escape) — no external dependency.

`corsForBrand` gracefully degrades to a no-op when `brand.rootDomain` is null (no auth.url case).

**Coexistence with existing `CORS_ALLOWED_ORIGINS` env var:** the env-derived global `corsOrigins` array remains for Companion's own routes (OAuth flows). The new `corsForBrand` is layered specifically on `/api/uppy/*`. They don't conflict — different mount points.

### 6.7 `src/modules/auth/auth.middleware.ts` and `auth.service.ts`

**No changes.** `extractToken` already reads from header → cookie. `requireAuth` already enforces `auth.url` presence and gives a 401 when the cookie is missing. The existing logic is what consumes the cross-subdomain cookie.

## 7. Client-side changes

### 7.1 `src/modules/companion/uppyModal.ts`

- Remove the `bearerToken` option from `HelperOptions` and from the public input shape.
- Remove `const BEARER_TOKEN = readOption(...)`, `const authHeaders = …`, and `mergeHeaders`.
- Replace `fetchWithAuth` with a thin wrapper that sets `credentials: 'include'`:

```ts
const fetchWithAuth = (url: string, options: RequestInit = {}) =>
    fetch(url, { ...options, credentials: 'include' });
```

All seven existing callsites of `fetchWithAuth` continue to work — they were calling it for the auth headers, but the new wrapper provides cookie auth implicitly.

### 7.2 `src/modules/companion/uppy.html`

The `<script type="module">` no longer reads `bearerToken`. The call to `uppyModal({ bearerToken, ... })` drops the field.

## 8. Backend pre-deploy checklist (operator's responsibility)

Before deploying this version, the brand backend operator must verify:

1. **Cookie scope.** `Set-Cookie` from the brand login endpoint includes `Domain=.<rootDomain>` (e.g. `Domain=.abeduls.com`), `HttpOnly`, `Secure` (in production), and `SameSite=Lax`.
   - Laravel: `config/session.php` → `'domain' => '.abeduls.com'`, `'secure' => true`, `'http_only' => true`, `'same_site' => 'lax'`.
   - Verify with `curl -i https://api.abeduls.com/login -d ...` and inspect the `Set-Cookie` header.

2. **CORS on every backend the Uppy page calls cross-origin** (currently `publicUploadUrl`; `foldersUrl` is server-to-server from Companion and does not need CORS). For each browser-facing endpoint:
   - `Access-Control-Allow-Origin` echoes the request `Origin` when it matches the same regex as Companion uses: **`https://*.<rootDomain>` only in production**, with `http://` allowed only for explicit local/dev origins. Echoing an `http://` origin under the brand root with `Allow-Credentials: true` reintroduces the same plain-HTTP exfiltration vector that §6.6 closes on Companion's side.
   - `Access-Control-Allow-Credentials: true`.
   - `Access-Control-Allow-Methods` includes the methods used by the frontend — currently `GET, POST, OPTIONS` for `publicUploadUrl` (no `PUT` or `DELETE` in the existing flow).
   - `Access-Control-Allow-Headers` includes `Content-Type` and any custom headers the frontend sends.
   - `OPTIONS` preflight is handled and returns `204` (or `200`) with the headers above.

3. **`loginUrl` endpoint accepts `?redirect=<url>` and validates the redirect target against an allow-list** (e.g. only redirect to URLs starting with `https://companion.<rootDomain>`). This is the dashboard's responsibility — Companion only constructs the URL, it does not validate.

4. **Brand JSON updated** with `rootDomain` and `public.loginUrl`.

A `npx tsx scripts/verify-brand-config.ts` invocation must succeed before deploy.

## 9. Threat model

### 9.0 Trust boundary (operator's invariant — REQUIRED)

This design's CORS policy explicitly trusts **every subdomain** under `<rootDomain>` as first-party. The operator MUST guarantee:

- **No parked or unclaimed subdomains** under `<rootDomain>` (e.g. `staging.<rootDomain>`, `old-app.<rootDomain>` left dangling and squattable).
- **No untrusted hosting** of arbitrary content under `<rootDomain>` (e.g. user-generated subdomains, third-party SaaS using vanity subdomains, marketing landing pages with permissive CMS access).
- **No HTTP-only services** under `<rootDomain>` in production. All subdomains must serve over HTTPS (the CORS regex in production already enforces `https://`, but the operator should also ensure no HTTP listener exists that could be tricked into running attacker-controlled JS).

If any of these is violated, an attacker can mount authenticated requests against Companion's `/api/uppy/*` from a sibling subdomain. `SameSite=Lax` does NOT protect against this — sibling subdomains are *same-site*. The mitigation lives in the trust assumption, not in the cookie attribute.

### 9.1 Mitigated by this design

| Threat | Mitigation |
|--------|------------|
| **XSS reading bearer from window scope or HTML source** | Token never exists in JS or HTML. Only as `HttpOnly` cookie value. |
| **XSS calling `document.cookie`** | Cookie set with `HttpOnly` flag. |
| **Cross-site CSRF** (attacker page on a different registrable domain) | `SameSite=Lax` on the brand session cookie. Cross-site requests do not include the cookie. |
| **Token leak via URL** (proxy/CDN logs, browser history, Referer) | Token never in URL. The `?bearerToken=` query parameter is removed. |
| **Token leak via service worker / cache** | Cookie is HttpOnly — service workers can't read it. |
| **Plain-HTTP credentialed exfil under root** (a page on `http://anywhere.<rootDomain>` reading authenticated responses via CORS) | CORS regex in production requires `https://` only; HTTP origins are not echoed even if the URL matches the rootDomain. |

### 9.2 NOT mitigated (out of scope, deferred)

| Threat | Why deferred |
|--------|--------------|
| **Same-site sibling subdomain CSRF/exfil** (compromised, parked, or third-party-hosted subdomain under `<rootDomain>` performing authenticated mutations) | Mitigated only by §9.0 operator invariant. Future hardening: a custom-header CSRF gate (`X-Companion-Client: 1`) on mutating routes — browsers do not send custom headers cross-origin without preflight, and our `Access-Control-Allow-Headers` can omit it for non-trusted origins. Or per-brand explicit subdomain allowlist instead of `*.<rootDomain>` regex. Tracked in `DEBT_TECH.md` #4 future hardening. |
| **XSS executing arbitrary fetches with the user's cookie** | Same-origin XSS retains full power to call any endpoint as the user. Mitigation requires CSP + SRI — separate hardening pass (`DEBT_TECH.md` #4 Option C). |
| **Compromise of the Uppy CDN or sweetalert2 CDN** (the `<script src=...>` tags loaded externally) | Mitigation is Subresource Integrity hashes — separate hardening pass. Listed as future work. |
| **Brand backend compromise** | Out of scope. If the brand backend is compromised, attacker has direct access regardless of Companion. |
| **Multi-tenant where Companion ≠ brand registrable domain** | Deferred as Option B in `DEBT_TECH.md` #4 (BFF proxy through Companion). |

## 10. Testing plan

### 10.1 Manual end-to-end (must pass before merge)

| Scenario | Expected |
|----------|----------|
| User logs in to `dashboard.abeduls.com`, clicks "Upload", lands on `companion.abeduls.com/abeduls/uppy` | Page renders. **Page source (View Source) contains no JWT/token literal anywhere.** Upload completes. |
| User opens `https://companion.abeduls.com/abeduls/uppy` directly (no prior login) | 302 redirect to `https://dashboard.abeduls.com/login?redirect=https%3A%2F%2Fcompanion.abeduls.com%2Fabeduls%2Fuppy`. |
| Brand JSON without `loginUrl`, user opens `/uppy` without cookie | Static 401 page (`Session Expired`). No 302. |
| User on `dashboard.abeduls.com` makes `fetch('https://companion.abeduls.com/abeduls/api/uppy/sign-s3', { credentials: 'include' })` | 200 OK with Access-Control-Allow-Origin echoing `https://dashboard.abeduls.com`. |
| Same fetch from `https://evil.com` | Browser blocks (no Access-Control-Allow-Origin). |
| In production, fetch from `http://anywhere.abeduls.com` (HTTP, same root) | Companion does NOT echo Access-Control-Allow-Origin (HTTPS-only regex). Browser blocks the response. |
| Response of `GET /uppy` includes `Cache-Control: no-store` | Verified via `curl -I` or DevTools network panel. |
| Brand JSON missing `rootDomain` while `auth.url` is set | Server fails to start with Zod validation error mentioning `rootDomain is required`. |
| Cookie expires while user is on `/uppy` and clicks Upload | Same-origin call returns 401. UI surfaces error. (Future enhancement: auto-redirect to login.) |

### 10.2 Type & build

- `pnpm typecheck` green.
- `pnpm build` produces `dist/modules/companion/{uppyModal.js,uppy.html}` and `uppy.html` no longer contains `BEARER_TOKEN_VALUE`.
- `grep -r BEARER_TOKEN src/` returns no matches.
- `grep -r bearerToken src/` returns no matches outside the `extractToken` legacy of accepting `Authorization: Bearer` header (kept for server-to-server cases).

### 10.3 Verify-brand-config script

Update `scripts/verify-brand-config.ts` to assert:
- If `auth.url` set, `rootDomain` is present.
- If `loginUrl` is missing, print a warning (not an error).

## 11. Migration / rollout

1. **Branch:** all work on `feat/cookie-only-auth`. PR against `main`.
2. **Sequence per pre-deploy checklist** (§8) is **operator-side first**, then code:
   - Operator updates Laravel session config to `Domain=.abeduls.com` if not already there.
   - Operator updates CORS on `api.abeduls.com` and any other subdomains called from Uppy.
   - Operator updates dashboard's login endpoint to accept `?redirect=` and validate it against an allow-list.
   - Operator updates `ABEDULS` env var with `rootDomain` and `public.loginUrl`.
3. **Code deploy** (this PR) only after operator confirms §8 items.
4. **Smoke test in production** using the §10.1 scenarios.
5. **Rollback:** revert the merge commit. Brand keeps working as long as the `Domain=.abeduls.com` cookie is in place (the bearer-in-URL flow used to work the same way; old code is git-revertible).

## 12. Out of scope — deferred to `DEBT_TECH.md`

This section restates what is intentionally not addressed.

- **Multi-tenant case (Option B):** Companion deployed on a registrable domain different from the brand backend (e.g. `uploads.platform.com/abeduls` + `api.abeduls.com`). In that topology, cross-subdomain cookies do not work because there is no shared registrable domain. Resolution: Companion acts as a Backend-for-Frontend, accepting same-origin requests from its own page and proxying them to the brand backend with server-stored tokens. The bearer never enters the browser. Documented as `DEBT_TECH.md` #4 future work.
- **CSP and SRI hardening of `/uppy`** to reduce XSS impact regardless of token storage.
- **Separation of long-lived session cookie from short-lived upload-session token.** OAuth-style cookie + access-token split.
- **Replay protection** beyond what `SameSite=Lax` provides.
