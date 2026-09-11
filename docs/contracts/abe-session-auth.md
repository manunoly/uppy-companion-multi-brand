# abe session authentication — the contract

How this Companion learns **who the browser is** for the `abe` brand, without asking the auth origin
on every request.

> **Provenance.** This is a mirror of abeduls3's canonical contract, adapted to this repo. Upstream
> sources, pinned at commit `f03e5f3` (2026-09-06):
>
> - `documentation/EXTERNAL_SERVICE_AUTH.md` — the portable version, written for consumers outside
>   that monorepo. **This is the file to re-read when upstream changes.**
> - `docs/standards/better-auth.md` §7 — the pattern and why each state exists.
> - `packages/auth-verify/src/` — the reference implementation (4 files, ~350 lines; only runtime
>   dependency is `jose`).
> - `apps/node-socket/src/auth/resolvePartnerSocketIdentity.ts` — the closest analogue to this repo:
>   a standalone Node service that verifies abe locally and forwards partner brands to their whoami.

---

## 0. Scope — this changes `abe` only

| Brand | `auth.kind` | How identity is resolved | Affected by this doc |
|---|---|---|---|
| `abe` | Better Auth behind `auth.abeduls.com` | **Local JWT verification**, whoami only on a miss | **Yes** |
| `edo` | `partner-whoami` | Forward `auth_session` to the partner whoami | No — unchanged |
| `picaboo` | `partner-whoami` | Forward `picaboo_session` to the partner whoami | No — unchanged |

The Redis cache, the circuit breaker, the SSRF gate on the whoami target and the body cap all stay
exactly as they are. The only new thing is a **local verification step that can answer without the
network** for `abe`.

---

## 1. Two cookies, two different jobs

Better Auth issues **two** cookies on the shared SSO domain (`.abeduls.com`). They are not
interchangeable and must never be named from the same variable.

| Cookie | What it is | Lifetime | Verifiable offline? | Job |
|---|---|---|---|---|
| `<prefix>better-auth.session_token` | **The credential.** An opaque session row id, signed as `<token>.<signature>` | the session (24 h) | **No** — revoking is a delete at the origin, so only the origin can judge it | Its presence is the only thing that means "this request claims an identity" |
| `<prefix>better-auth.session_data` | **A cache of the answer.** A JWT of `{session, user}` signed with the JWKS private key | **300 s** (`cookieCache.maxAge`) | **Yes**, with the public key alone | Lets us skip the network hop on the happy path. Never authority |

Three rules fall straight out of that table:

- **The gate reads `session_token`. The answer comes from `session_data`.** Reversing this builds a
  system that logs users out every time a 300-second cache expires.
- **`session_data`'s absence is never an authentication failure.** It is a cache miss.
- **`session_data` chunks; `session_token` never does.** Above ~4050 bytes Better Auth splits the
  data cookie into `…session_data.0`, `…session_data.1`, … . A reader that only looks for the exact
  name sees a signed-in user as anonymous the moment their payload grows. Collect every key starting
  with `<name>.`, sort by the numeric suffix, concatenate.

### Cookie names are derived, never written down

The `__Secure-` prefix is a property of **the origin that set the cookie**, not of the build. Derive
it in exactly one function, from the auth origin's protocol:

```ts
const isSecure = issuer.startsWith('https://');
const prefix = isSecure ? '__Secure-' : '';
const names = {
    sessionToken: `${prefix}better-auth.session_token`,
    sessionData: `${prefix}better-auth.session_data`,
};
```

Never derive it from `NODE_ENV`. Never bake a prefixed literal into the brand registry, an env
default, or a test fixture — such a literal is correct only in the environments that happen to match
it, and its failure mode is a silent "no session found".

### What the JWT carries, and what you must check

```
GET https://auth.abeduls.com/api/auth/jwks
{"keys":[{"alg":"EdDSA","crv":"Ed25519","x":"…","kty":"OKP","kid":"…"}]}
```

| Field | Value | Why you check it |
|---|---|---|
| header `typ` | `better-auth.session-cache+jwt` | Rejects any other JWT from the same issuer replayed as a session |
| header `kid` | matches a JWKS key | On an unknown `kid`, refetch the JWKS **once** — that is key rotation, not an attack |
| `alg` | `EdDSA` (Ed25519, `kty: OKP`) | Pass an explicit algorithm allowlist. Never accept `alg` from the token |
| `iss` | `https://auth.abeduls.com` | Must match **byte for byte**, trailing slash included |
| `aud` | `better-auth:session-cache` | |
| `exp` | ≤ 300 s out | Allow 15 s clock tolerance |
| `sub` | the user id | Must equal `user.id` in the payload |
| `sid` | the session token | Must equal `session.token` in the payload |
| `user` | `{ id, email, emailVerified, name, image }` | `email` arrives lowercased |
| `session.expiresAt` | ISO-8601 with `Z` | Check separately from `exp`, with **no** tolerance. The 15 s leeway is for `exp` only |

---

## 2. Six outcomes, not two

A verifier that returns a boolean is the bug this section exists to prevent.

```ts
type SessionCookieResult =
    | { status: 'valid'; user: SessionUser; session: Record<string, unknown> }
    | { status: 'absent' }
    | { status: 'expired' }
    | { status: 'poisoned' }
    | { status: 'credential-mismatch' }
    | { status: 'unavailable' };
```

| Outcome | Meaning | What you do |
|---|---|---|
| `valid` | Verified **and bound** to the presented credential | Serve the request |
| `absent` | No `session_data` | Ask the origin (whoami), or treat as anonymous |
| `expired` | Past `exp` or `session.expiresAt` | Ask the origin — the session may still be live |
| `poisoned` | Bad signature, wrong `typ`/`aud`/`iss`, unparseable | **Stop trusting this copy, but ask the origin.** It says nothing about the credential beside it |
| `credential-mismatch` | Verified but not bound to the presented credential | Ask the origin, **with the cookie cache bypassed** |
| `unavailable` | JWKS unreachable, import failed, timeout | **Fail soft** for this request only. Degrade to anonymous, never delete a cookie |

Read the table again for the two rows that look like they should behave the same and do not:
`poisoned` and `unavailable`.

### The decision tree, in this exact order

```
no session_token                -> anonymous. No verification, no network. (Cheapest, most common.)

session_token present -> verify session_data locally (public key from JWKS, no network):

    valid                       -> authenticated. ZERO calls to the origin.
    expired | absent | poisoned -> whoami fallback. Only its answer may reject.
    credential-mismatch         -> whoami fallback with the cache bypassed, forwarding the
                                   credential ALONE (see 3.5).
    unavailable (JWKS down)     -> FAIL SOFT: unauthenticated for THIS REQUEST ONLY.
                                   Never delete a cookie, never open the breaker.
```

---

## 3. Six non-negotiables

### 3.1 Bind the JWT to the credential presented with it

This is the rule everyone forgets, and skipping it is a real authentication bypass. `session_data`
is a *cache*: it proves the origin once said this session existed, **not** that the caller holds it.
Nothing in the signature ties the JWT to the jar it arrived in.

The exploit is one line of devtools: keep a `session_data` for user V, replace `session_token` with
any string. A presence-only gate passes it, the JWT verifies, and the request is V.

```
presented = cookie("…session_token").split(".")[0]     // strip Better Auth's .<signature>
if (payload.session.token !== presented)  ->  credential-mismatch, NOT authenticated
```

Check it **before** you even fetch the JWKS. And put the binding **inside the verifier**, not in
each caller — an opt-in check is one every future caller can forget, and forgetting it is silent
because the happy path is identical.

### 3.2 "Could not verify" is not "not authenticated"

`poisoned` is a cache miss, not a verdict on the user. A `session_data` that fails to verify proves
nothing about the `session_token` beside it, and the whoami checks that credential independently — a
forged or replayed token still dies there, while a merely truncated or corrupted cache recovers. So
route `poisoned` through the same fallback as `expired`/`absent`, and fail closed **only when the
origin itself answers no-session**.

The concrete reason it matters: rotating a JWKS key makes every outstanding `session_data` verify as
`poisoned`. A service that fails closed on the cache verification alone turns routine key rotation
into a hard sign-out for every user holding a perfectly valid credential.

And never treat `unavailable` as a rejection. A JWKS outage is not a revoked session. In this repo
that also means: **`unavailable` must not touch `whoami-breaker`** — a local verification failure is
not evidence about the partner's health.

### 3.3 The revocation window is a number you write down

The pattern trades revocation latency for load. State it as a sum, and update it whenever anyone
adds a cache or raises a TTL:

```
revocation window = session_data maxAge + every consumer-side identity cache
this Companion    = 300 s (session_data) + 45 s (CACHE_TTL_SECONDS in session-resolver.ts)
                  = ~5 min 45 s
```

A signed-out or admin-revoked session keeps resolving for that long. **For this service that is
acceptable and no bypass list is needed**: Companion's surfaces are file uploads and OAuth provider
handshakes — none of them changes a credential, a session, money, or a privilege. If a future
endpoint does, it gets a live read with `?disableCookieCache=true`, and this paragraph gets
rewritten rather than the global TTL being lowered.

### 3.4 Cache the JWKS in memory with no TTL; refetch on an unknown `kid`

A fixed TTL either hammers the origin or leaves you unable to verify a freshly rotated key. Refetch
once when you meet a `kid` you do not know, and de-duplicate concurrent fetches so a cold start does
not fan out.

The cost of no TTL, which you should know rather than discover: **removing** a key from the JWKS
never reaches a warm process, so it keeps accepting tokens signed by an emergency-revoked key until
it restarts. A redeploy is the flush. Put that in the revocation runbook — do not "fix" it with a
short TTL, which reintroduces the problem this rule avoids.

The cache belongs at **module scope**. It must outlive the request.

### 3.5 If you relay identity onward, forward BOTH cookies

By name, as a matched pair, chunk-aware. Forwarding `session_token` alone **silently disables the
receiver's cache**: it finds no `session_data`, cannot verify locally, and does a live read on every
single request. Nothing breaks, nothing is logged, every test passes, and the auth service absorbs
traffic proportional to yours. This exact defect shipped in abeduls3's designer and was only found
by an audit.

The one exception is the mirror image of 3.1: when you are relaying **because** you got
`credential-mismatch`, forward the credential **alone**. Handing over the `session_data` you just
distrusted invites the receiver to authenticate that jar on the strength of the very cookie you
rejected.

Forward by name, never the whole inbound `Cookie` header — and keep routing it through
`buildCookieHeader` (`src/modules/brand/identity.ts`), which is already the single auditable point
that rejects delimiter and control characters.

### 3.6 This tells you *who*, never *what they may do*

Authorization stays here. The brand's `requireVerifiedEmail` gate still applies — read
`user.emailVerified` straight off the JWT payload; it is there, so the gate costs nothing on the
local path.

---

## 4. Reference implementation (Node)

`@package/auth-verify` is `private: true` and resolved as `workspace:*`, so
`pnpm add @package/auth-verify` will **not** work from here. **Vendor it.** Copy
`packages/auth-verify/src/` — four files, ~319 lines, importing nothing but `jose` and one type
from `node:crypto` — into `src/vendor/auth-verify/`, and add `jose` to `dependencies`.

Publishing it to a registry was evaluated and declined: at the current number of consumers the
pipeline costs more than it returns. Two facts worth keeping, so nobody re-derives them:

- pnpm's `publishConfig` **cannot** override `name` (`PUBLISH_CONFIG_WHITELIST` in the shipped
  bundle lists `bin, engines, type, imports, main, module, typings, types, exports, browser, esnext,
  es2015, unpkg, umd:main, os, cpu, libc, typesVersions` — the docs' prose is wrong). Publishing
  therefore requires renaming the package across the monorepo, ~15 files.
- The package holds no signing material, so if it is ever published, **public npm under an
  organisation scope** is the right home — that is where Clerk, Auth0 and Supabase put theirs, and
  it deletes the registry token from every dev machine, CI runner and Docker build.

**Copy it byte-identically.** Do not concatenate the files, do not reformat them, and do not add a
header comment inside them. The whole value of a vendored copy is that this returns nothing:

```bash
diff -r <abeduls3>/packages/auth-verify/src src/vendor/auth-verify
```

Any transformation on the way in destroys that check. The "do not edit" notice goes in a sibling
`src/vendor/auth-verify/VENDORED.md`, never inside a `.ts` file.

Reimplementing against section 1's table instead is defensible, but you then own the binding check
and all six states, and 3.2's two fail directions are yours to get right.

```ts
import { createJwksCache, verifySessionCookie } from './vendor/auth-verify/index.js';

// One instance per process — createJwksCache holds the key set in a closure, so building it
// per request refetches the JWKS on every request.
const jwks = createJwksCache({ authOrigin: issuer });

const prefix = issuer.startsWith('https://') ? '__Secure-' : '';

export async function verifyAbeSession(headers: Headers) {
    return verifySessionCookie(headers, {
        jwks,
        issuer,
        sessionDataName: `${prefix}better-auth.session_data`,
        sessionTokenName: `${prefix}better-auth.session_token`, // required — this is the binding
    });
}
```

**One value, not two.** An earlier draft of this document split the auth origin into a public issuer
and a separate JWKS fetch origin. They are the same string in every environment this service runs
in, and a second copy only doubles the chance of the failure below. The JWKS URL is derived from the
issuer.

**The issuer must match auth-service's `BETTER_AUTH_URL` byte for byte, trailing slash included.**
If it diverges, nothing errors — every verification simply misses and you silently fall back to a
round trip per request. That is the failure this whole pattern exists to avoid, restored in silence
and invisible except as auth-origin traffic.

The issuer is per-brand configuration, so it lives in the brand registry with the standard
`<SLUG>_BRAND_OVERRIDE` escape hatch — not in the global env schema, which is brand-independent by
design. The snippet above is illustrative, not a licence for module-level `process.env`.

---

## 5. How it lands in this codebase

### 5.1 Where the code goes

`src/modules/auth/session-resolver.ts` already documents its step order as a security property. The
local verify is a **new step for `abe` only**, between the breaker check and the Redis read:

```
1.  Extract the cookie value by the brand's effective cookie name   <- abe: now the DERIVED names
2.  SSRF gate (resolveValidatedWhoamiTarget)                           unchanged
3.  buildCookieHeader — a malformed value is a CLIENT error            unchanged (see 5.3)
4.  Circuit breaker fail-fast                                          unchanged
4b. [NEW, abe only] verifyAbeSession(headers)
        valid                   -> return authenticated — no Redis, no fetch, no breaker
        unavailable             -> log warn, fall through. Do NOT touch the breaker
        credential-mismatch     -> fall through, forwarding the CREDENTIAL ALONE
        absent|expired|poisoned -> fall through to the normal path
5.  Redis cache read (45 s)                                            unchanged
6-9. whoami fetch, status interpretation, body cap, normalize, gate    unchanged
```

Keep the cache key hashed off the **`session_token` value** (the credential), not off `session_data`
— a data cookie that rotates every 300 s would otherwise dilute the cache to nothing.

`attachUser` / `requireAuth` in `auth.middleware.ts` need **no change**: the `SessionResolution`
union they already switch on (`authenticated | unauthenticated | unavailable | misconfigured`) is
the right shape for the caller. The six states are the *verifier's* vocabulary and must not leak
past `resolveSession`.

### 5.2 Chunk handling — the part that is easy to get backwards

- The **gate** (does this request claim an identity?) reads `session_token`, which never chunks, so
  it needs no chunk logic.
- The **verifier and any forward** read `session_data`, which does chunk, so every `<name>.N` must
  be collected and reassembled by numeric index.

`extractCookieValue` in `session-resolver.ts` is an exact-name matcher — correct for the credential,
**insufficient** for the data cookie. abeduls3's node-socket hit this and added a
`parseCookieEntries` helper that enumerates all entries; port that shape rather than extending the
regex.

### 5.3 One wrinkle in the existing step 3

Step 3's comment says a delimiter-bearing cookie value is a client error that must never reach the
breaker. That reasoning is unchanged and still right. Note only that it now runs against a cookie
name that is **derived** for `abe`, so the abe branch must call `buildCookieHeader` for each of the
two names it may forward, not once for a single registry-configured name.

---

## 6. Open item to resolve BEFORE implementing

**The `abe` brand is configured against a cookie capsule no longer issues.**

`src/modules/brand/registry.ts`, abe entry:

```ts
auth: {
    kind: 'partner-whoami',
    whoamiUrl: 'https://www.abeduls.com/api/user',
    sessionCookieName: 'abes_session',
}
```

In abeduls3 today:

- `apps/capsule/CLAUDE.md` records that "`EdgeSessionVerifier` and the `abes_session` cookie are gone
  entirely" — capsule reads identity from the Better Auth cookies and mints no `abes_session`.
- `packages/brands/src/types.ts` gives the `capsule` brand kind **no** `sessionCookieName` at all:
  *"capsule derives its cookie name from `betterAuthCookieNames`, not the registry."*
- The only surviving `abes_session` mentions in that repo are stale comments and an OpenAPI fixture.

If that holds in production, `extractCookieValue(header, 'abes_session')` returns `null` for every
abe browser today and `resolveSession` answers `unauthenticated` before it ever reaches the whoami —
so abe uploads fail at the auth gate, rather than merely paying an extra hop.

### Finding — 2026-09-11, source-level only

Checked against abeduls3 at commit `708c52cc`. **This is source-level evidence, not a production
observation.** No request was made, no server was started, and the live check below remains
outstanding.

What the source says:

- `apps/capsule/lib/auth/session.ts` mints nothing. Every session read goes through
  `getBetterSession()`; the only cookies it writes are `pending_email_verification` and the
  remembered-email one. There is no `cookieStore.set('abes_session', …)` anywhere under
  `apps/capsule/lib/auth/`.
- `apps/capsule/lib/auth/better/session.ts` reads identity by calling `verifySessionCookie` from
  `@package/auth-verify` against the Better Auth cookies, relaying to `/api/auth/get-session` only
  on `unavailable`, `credential-mismatch` or a stale cache beside a live credential.
- `apps/capsule/app/api/user/route.ts` — the very whoami this Companion calls — is
  `getBetterSession()` plus `resolveMirrorUser`. It never looks at `abes_session`.
- `SESSION_COOKIE_NAME` still exists in `apps/capsule/.env.local`, but **zero** `.ts`/`.tsx` files in
  `apps/capsule/` read it. It is a dead env var.
- Every surviving `abes_session` mention under `apps/capsule/` is a comment, an archived doc
  (`documentation/security-sessions.md`), an env-file line, or the OpenAPI fixture
  (`lib/api/openapi/.spec.json`). None is a writer.

So the contract's premise holds on the evidence available: capsule issues no `abes_session`, and
`extractCookieValue(header, 'abes_session')` must be returning `null` for every abe browser. This
work is a fix, not an optimization.

**Still outstanding:** the one-request live check — an authenticated abe browser hitting a Companion
host, with the inbound `Cookie` header's *names* logged (never their values). It is the only thing
that can rule out a cookie-domain or CORS problem sitting in front of this one, which this plan
would not fix. Close it against staging alongside §7 item 9.

---

## 7. Implementation checklist

1. ~~Confirm section 6 against production.~~ **Partially done (Task 1)** — recorded in section 6 as
   source-level evidence. The live one-request check is still open; it rides with item 9.
2. ~~Add the brand's `authIssuer` to the registry entry.~~ **Done (Task 5)** — `authIssuer` +
   code-only `authAllowedHosts`, gated by `resolveValidatedAuthOrigin`.
3. ~~Write the cookie-name derivation in exactly one function.~~ **Done (Task 3)** —
   `src/modules/auth/abe-cookie-names.ts`; `grep -rn "better-auth.session" src/` returns only that
   file and its test.
4. ~~Vendor `auth-verify`.~~ **Done (Task 6)** — `src/vendor/auth-verify/`, byte-identical, with
   `VENDORED.md`, a `MANIFEST.sha256` enforced by a test, and `jose` in `dependencies`.
5. ~~Wire step 4b into `resolveSession`.~~ **Done (Task 7)** — `capsule` branch only; `unavailable`
   logs and falls through without touching the breaker.
6. ~~Port chunk-aware cookie parsing for `session_data`.~~ **Done (Task 4)** —
   `src/modules/auth/better-auth-cookies.ts`.
7. ~~Tests.~~ **Done (Tasks 4, 6, 7)** — one case per state in section 2, numeric-order chunk
   reassembly, and the 3.1 bypass attempt against the real vendored verifier
   (`abe-session-verifier.test.ts` → "rejects the same JWT presented with a foreign credential").
8. ~~Record the revocation window (3.3).~~ **Done (Task 8)** — see 3.3; `CACHE_TTL_SECONDS` is
   still 45, so the sum stands at ~5 min 45 s.
9. **OPEN — verify from the logs, not the code**: two uploads inside the window must produce
   **zero** abe whoami requests; one past the window exactly one. A code review cannot establish
   this, and neither can a test run. Close it against staging together with section 6's live check.

### Known consequence of verifying locally

A locally verified user never reaches capsule's `/api/user`, which is where `resolveMirrorUser`
creates that user's mirror row. Capsule's media-ingest endpoint inserts `uploads` keyed by the user
id behind a foreign key, with a `23503` handler — so a user who has never passed through a capsule
surface that provisions gets a **failed ingest**, not corruption.

The probability is low: reaching the designer at all goes through capsule's layout, which
provisions. But this failure mode is created by local verification and cannot exist on the
relay-only path, so it is recorded here rather than discovered in a support ticket. If it ever
fires, the signature is a `23503` in capsule's ingest logs for a user whose uploads previously
worked.

---

## 8. Do not

- **Do not** accept `session_data` without checking it is bound to the `session_token` beside it.
- **Do not** treat `unavailable` as unauthenticated, and never delete a cookie over it.
- **Do not** open the circuit breaker on a local verification failure.
- **Do not** trust the token's own `alg`; pass an explicit allowlist.
- **Do not** hardcode `__Secure-`, or read only the unchunked cookie name.
- **Do not** put a TTL on the JWKS cache, or refetch it per request.
- **Do not** fail closed on `poisoned` by itself. Only the origin's answer may reject a request.
- **Do not** forward `session_token` alone when relaying identity — except on `credential-mismatch`.
- **Do not** ask for the signing secret. The public JWKS is enough for everything described here.
