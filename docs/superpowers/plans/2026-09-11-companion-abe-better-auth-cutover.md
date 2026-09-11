# Companion abe auth cutover to Better Auth's two-cookie model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `abe` brand authenticate against Better Auth's real cookies — verifying `session_data` locally against the auth origin's JWKS and falling back to capsule's whoami on a miss — instead of the `abes_session` cookie capsule no longer issues.

**Architecture:** Port `apps/node-socket/src/auth/resolvePartnerSocketIdentity.ts` from abeduls3, which already solves exactly this for both brand kinds in one function: a single bifurcation at the top (`capsule` verifies locally then falls back; `partner-whoami` forwards as today), with the Redis cache, circuit breaker, SSRF gate, body cap and normalization shared below it. `session-resolver.ts` here is already a port of that file at an earlier revision, so this is bringing the port up to date, not a redesign. The verification logic is a **byte-identical vendored copy** of abeduls3's `packages/auth-verify/src/`, synced by hand.

**Tech Stack:** Node 22, Express 4, TypeScript 5, Vitest 4, ioredis, Zod 4, `jose` (the vendored verifier's only runtime dependency).

**Spec:** [`docs/contracts/abe-session-auth.md`](../../contracts/abe-session-auth.md) — the contract this implements, mirrored from abeduls3's `documentation/EXTERNAL_SERVICE_AUTH.md` and `docs/standards/better-auth.md` §7.

## Global Constraints

- **`edo` and `picaboo` must keep working.** Task 2 deliberately changes shared whoami behavior for all brands; every other task must leave the `partner-whoami` path byte-identical. `src/modules/auth/session-resolver.test.ts` is the regression gate and its existing assertions must not be edited to accommodate new code.
- **The step order in `resolveSession` is a security property, not style.** Specifically: `buildCookieHeader` must run **before** the breaker check, or an unauthenticated caller opens the breaker for every user of a brand by spamming malformed cookies. Preserve that relationship in every reordering.
- **A local verification failure must never touch the circuit breaker.** The breaker tracks the *partner's* health; a JWKS problem is ours.
- **Never delete a cookie, and never fail closed, on `unavailable`.** Contract §3.2.
- **Cookie names are derived from the auth origin's protocol, in exactly one function.** Never from `NODE_ENV`, never as a literal with `__Secure-` baked in. Contract §1.
- **`session_data` chunks; `session_token` never does.** The gate needs no chunk logic; the verifier and any forward do. Contract §5.2.
- **The vendored copy is byte-identical to upstream, always.** `diff -r <abeduls3>/packages/auth-verify/src src/vendor/auth-verify` returning nothing IS the sync check — so never reformat it, never concatenate its files, and never add a comment inside a `.ts` file there. The "do not edit" notice lives in a sibling `VENDORED.md`. Any transformation on the way in destroys the only cheap verification this approach has.
- Package manager is **pnpm**. Node >= 22.
- All user-visible and repo-written text is **English**. Code and comments in English.
- Comments: one short line maximum, only where the WHY is non-obvious.
- No `any`. All Zod schemas keep the repo's existing conventions.
- Allowed verification commands: `pnpm typecheck`, `pnpm lint`, `pnpm test <path>`, `pnpm build`. **Forbidden:** booting a dev server, `docker compose`, editing `.env`, and anything that reads or writes a real credential value.
- **Secrets are provisioned by a human.** No task may read, echo, interpolate or generate a token. Tasks that need one state which variable must exist and stop there.

## Design Decisions

**D1 — Port node-socket, do not invent.** `resolvePartnerSocketIdentity.ts` is the reference implementation named in the contract, it is already in production, and `session-resolver.ts`'s own docstring says it mirrors that file. Four behavioral gaps separate them today (Tasks 2, 3, 4, 7). Treating this as a fresh design would re-derive decisions that were already paid for with incidents.

**D2 — `abe` flips to `kind: 'capsule'`, and `kind` stops being cosmetic.** The registry entry currently says `kind: 'partner-whoami'` with a comment calling `kind` cosmetic. After this plan `kind` is the branch selector, so the comment and the value both change. `kind` is already in `PROTECTED_AUTH_KEYS` (`src/modules/brand/identity.ts`), so no `<SLUG>_BRAND_OVERRIDE` can flip a partner into the local-verify path.

**D3 — The auth origin gets its own SSRF allowlist, mirroring the whoami pair — but it is ONE field, not two.** `authIssuer` is per-environment (prod `https://auth.abeduls.com`, dev `https://auth.abeduls.local`), so it must be overridable like `whoamiUrl`. But `resolveEffectiveAuth` makes *any* string field present on the base object overridable, and an overridable issuer with no allowlist is an arbitrary-auth-origin switch: an attacker-controlled JWKS mints `valid` for anything. So `authAllowedHosts` is added to `PROTECTED_AUTH_KEYS` and the issuer is validated against it with the existing `isWhoamiHostAllowed` suffix matcher — the codebase's own `whoamiUrl`/`whoamiAllowedHosts` pattern, applied to a second field.

A separate `jwksOrigin` was in an earlier draft and is **deliberately cut**. It equalled `authIssuer` in every environment either document named; its stated rationale (the JWKS fetch might cross a private network) is speculative for a Railway service that already reaches `www.abeduls.com` over the public internet for the whoami. Two fields double the allowlist surface and the tests, and add a second byte-for-byte footgun for no buyer. The JWKS URL is derived from the issuer.

**D4 — Vendor `packages/auth-verify/src/`, do not publish it.** Publishing was planned and then declined: at the current number of consumers the registry pipeline costs more than it returns. Two findings are worth recording so nobody re-derives them — pnpm's `publishConfig` cannot override `name` (verified against `PUBLISH_CONFIG_WHITELIST` in the shipped 10.23.0 and 10.32.1 bundles; the documentation's prose is wrong), so publishing would require renaming the package across ~15 files in abeduls3; and if it is ever published, the package holds no signing material, so public npm under an organisation scope is the right home rather than a private registry.

The accepted cost is that copies are synced by hand and can go stale. Task 6 buys that down with two mechanical checks totalling ~25 lines, and nothing more.

**D5 — The issuer does not go in `envSchema`.** `src/config/env.schema.ts` is explicitly brand-independent and its own header says per-brand values are read at brand-resolution time, not through the schema. `authIssuer` is per-brand, so it lives in the registry entry with the standard `<SLUG>_BRAND_OVERRIDE` escape hatch, consistent with `whoamiUrl`.

**D6 — This plan does not add a sensitive-route bypass list.** Contract §3.3: Companion's surfaces are uploads and OAuth handshakes; none changes a credential, a session, money or a privilege. The resulting revocation window (~5 min 45 s) is recorded in Task 8 as an accepted number. Adding a bypass mechanism nothing needs is a layer that would break nothing if deleted.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/auth/abe-cookie-names.ts` | **Create.** The single derivation of `session_token`/`session_data` names from an issuer's protocol, plus the both-candidates helper. |
| `src/modules/auth/better-auth-cookies.ts` | **Create.** Chunk-aware cookie-header parsing and the two forward builders (`buildBetterAuthPair`, `buildCredentialOnly`). |
| `src/vendor/auth-verify/` | **Create.** Byte-identical copy of abeduls3's `packages/auth-verify/src/` — `index.ts`, `jwks.ts`, `sessionCookie.ts`, `verify.ts`. Never edited here. |
| `src/vendor/auth-verify/VENDORED.md` | **Create.** The sync record and the "do not edit" rule. Sibling file, so the sources stay byte-identical. |
| `src/vendor/auth-verify/MANIFEST.sha256` | **Create.** Per-file hashes, checked by a test, so a hand edit fails CI. |
| `src/modules/auth/abe-session-verifier.ts` | **Create.** Wraps the vendored `verifySessionCookie` and narrows its six states into this codebase's vocabulary. |
| `src/modules/brand/brand.contract.ts` | **Modify.** `capsule` variant: `sessionCookieName` becomes optional, `authIssuer`/`authAllowedHosts` are added. |
| `src/modules/brand/brand.schema.ts` | **Modify.** The Zod mirror of that type. It is `.strict()` and parsed at boot, so a registry entry the schema does not know about crashes the service on start. |
| `src/modules/brand/identity.ts` | **Modify.** `authAllowedHosts` joins `PROTECTED_AUTH_KEYS`; a new `resolveValidatedAuthOrigin` gates the issuer and JWKS origin. |
| `src/modules/brand/registry.ts` | **Modify.** The abe entry becomes `kind: 'capsule'` with the real auth origin. |
| `src/modules/auth/session-resolver.ts` | **Modify.** The shared-path alignment (Task 2) and the abe branch (Task 7). |
| `.env.example` | **Modify.** The abe override example. |
| `biome.json` | **Modify.** Exclude `src/vendor` — the 4-space formatter would rewrite the upstream files and destroy byte-identity. |
| `vitest.config.ts` | **Modify.** Exclude `src/vendor/**` from coverage — ~319 mocked lines would otherwise drag the 70% line gate down. |
| `docs/contracts/abe-session-auth.md` | **Modify.** Record the production finding and the revocation window. |
| `CLAUDE.md` | **Modify.** Update the `session-resolver.ts` architecture bullet. |

---

## Task 1: Confirm the production reality before writing any code

**Files:**
- Modify: `docs/contracts/abe-session-auth.md` (section 6 — record the answer)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded answer to "which cookies actually arrive at Companion for an authenticated abe user". Tasks 5 and 7 assume `better-auth.session_token` is among them.

**Why this is Task 1:** section 6 of the contract states that `abes_session` appears to be dead, which would mean abe uploads currently fail at the auth gate rather than merely paying an extra hop. That changes this work from an optimization into a fix, and it changes what "done" looks like. It is also the cheapest check in the plan.

- [ ] **Step 1: Capture the inbound cookie names on a real request**

With an authenticated abe browser session, open the designer's upload modal so it calls a Companion host, and read Companion's request log for that request. If the log does not already carry the cookie names, add a temporary `logger.debug` in `attachUser` (`src/modules/auth/auth.middleware.ts`) that logs **only the cookie names**, never their values:

```ts
logger.debug({ brand: brand.slug, cookieNames: (req.headers.cookie ?? '').split(';').map((c) => c.split('=')[0].trim()) }, '[auth] inbound cookie names');
```

Names only. A cookie value in a log is a session in a log.

- [ ] **Step 2: Classify what you found**

| What arrived | Meaning | This plan |
|---|---|---|
| `__Secure-better-auth.session_token` (+ `…session_data`) and **no** `abes_session` | abe auth is broken today; the contract's section 6 is confirmed | Proceed. This is a fix. |
| `abes_session` present | capsule still issues it somewhere; section 6 is wrong | **STOP.** Report `BLOCKED` and re-read abeduls3's `apps/capsule/lib/auth/` before proceeding — the premise of Tasks 5-7 is wrong. |
| Neither | The browser is not sending SSO cookies to the Companion host at all — a cookie-domain or CORS problem, not an auth-verification one | **STOP.** Report `BLOCKED`. This plan would not fix it. |

- [ ] **Step 3: Remove the temporary log**

Revert the `logger.debug` added in Step 1 if you added one. It must not ship.

- [ ] **Step 4: Record the answer in the contract**

In `docs/contracts/abe-session-auth.md`, replace the closing paragraph of section 6 ("**Verify this first, with a real request…**") with the finding, dated, naming the cookie names observed and nothing else.

- [ ] **Step 5: Commit**

```bash
git add docs/contracts/abe-session-auth.md
git commit -m "docs(contract): record which cookies actually reach Companion for abe"
```

---

## Task 2: Align the shared whoami path with node-socket

**Files:**
- Modify: `src/modules/auth/session-resolver.ts` (steps 4-7 of `resolveSession`)
- Test: `src/modules/auth/session-resolver.test.ts`

**Interfaces:**
- Consumes: the existing `SessionResolution` union — unchanged.
- Produces: the same union, with two behavior changes that every brand inherits.

**Why this is separate from the abe work:** it changes `edo` and `picaboo` too, so a reviewer must be able to accept or reject it on its own merits. Both changes come from node-socket's version of the same function.

**The two changes:**

1. **`401`/`403` become `unauthenticated` + `recordSuccess`; `429` and every other 4xx become `unavailable` + `recordFailure` + a warning log.** Today only `401` is treated as a client condition, so a `403` falls into `!response.ok` and calls `recordFailure` — three of those open the breaker for every user of the brand even though the upstream is perfectly healthy.

   **This is deliberately narrower than node-socket's version, which maps every 4xx to `unauthenticated` + `recordSuccess`.** Copying that here would be a defect, for two reasons node-socket does not face. First, `recordSuccess` is not a bookkeeping no-op: it `del`s the failure counter, the open flag and the probe lock (`src/modules/auth/whoami-breaker.ts:75-77`), and this breaker is Redis-backed and shared across replicas. So a `429` from a partner asking us to back off would be read as "user not signed in" *and* wipe the brake, and Companion would keep hammering them. Second, Companion fronts third parties; node-socket only ever talks to capsule. A `400`/`404`/`405` from a moved or misconfigured partner whoami must surface as a logged `503` with an open breaker, not as a silent fleet-wide 401 nobody can diagnose.

   The 404 rationale in node-socket's comment is also stale for capsule: `apps/capsule/app/api/user/route.ts` never returns 404 — it provisions the mirror row via `resolveMirrorUser` and returns `503` when the store is unavailable.

2. **The Redis cache is read BEFORE the breaker gate.** A hot cached identity needs no fetch at all, so it must survive a partner blip that has already opened the shared breaker. Reading the breaker first throws away a perfectly good cached answer during exactly the incident the cache exists for. This one is a straight port — it is safe for partners, and changes only what happens while the breaker is open.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/auth/session-resolver.test.ts`, inside the existing `describe`:

```ts
it('whoami 403 -> unauthenticated, and the breaker records a SUCCESS (upstream is healthy)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 403 }));

    const result = await resolveSession(edo, 'session=abc');

    expect(result.status).toBe('unauthenticated');
    expect(breaker.recordSuccess).toHaveBeenCalled();
    expect(breaker.recordFailure).not.toHaveBeenCalled();
});

it('whoami 429 -> unavailable and a FAILURE — never clear a brake the partner just asked for', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 429 }));

    const result = await resolveSession(edo, 'session=abc');

    expect(result.status).toBe('unavailable');
    expect(breaker.recordFailure).toHaveBeenCalled();
    expect(breaker.recordSuccess).not.toHaveBeenCalled();
});

it('whoami 404 -> unavailable and a FAILURE (a moved whoami route must be visible, not a silent 401)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 404 }));

    const result = await resolveSession(edo, 'session=abc');

    expect(result.status).toBe('unavailable');
    expect(breaker.recordFailure).toHaveBeenCalled();
    expect(breaker.recordSuccess).not.toHaveBeenCalled();
});

it('whoami 500 -> unavailable, and the breaker records a FAILURE', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 500 }));

    const result = await resolveSession(edo, 'session=abc');

    expect(result.status).toBe('unavailable');
    expect(breaker.recordFailure).toHaveBeenCalled();
});

it('a cached identity resolves even while the breaker is OPEN (cache is read first)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'u1', email: 'a@b.test', name: 'A', imageUrl: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }),
    );

    // Warm the cache with the breaker closed.
    const first = await resolveSession(edo, 'session=abc');
    expect(first.status).toBe('authenticated');

    // Now the partner goes down hard and the breaker opens.
    vi.mocked(breaker.isOpen).mockResolvedValue(true);
    vi.mocked(globalThis.fetch).mockClear();

    const second = await resolveSession(edo, 'session=abc');

    expect(second.status).toBe('authenticated');
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

```

**Do not add a new malformed-cookie test.** One already exists at `src/modules/auth/session-resolver.test.ts:58-73` — its title says `contains ";"` but its payload is `session=abc%0d%0aInjected:1`, a decoded CRLF, which is the case that actually reaches `buildCookieHeader`'s rejection. It already asserts `unauthenticated`, `recordFailure` not called, and `fetch` not called.

Instead, add **one line** to that existing test, because this task moves the cache read and the cache must not be consulted either:

```ts
        expect(breaker.isOpen).not.toHaveBeenCalled();
```

That assertion is the Global Constraint pinned in place, and it must keep passing through every later task. (A value carrying a bare `;` would NOT exercise this path: `extractCookieValue`'s `([^;]+)` stops at the semicolon and hands back a clean value.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test src/modules/auth/session-resolver.test.ts`
Expected: **only the 403 test and the cache-before-breaker test FAIL.**

The 429, 404 and 500 tests already PASS: today all three fall through to `if (!response.ok)`, which calls `recordFailure` and returns `unavailable` — exactly what they assert. They are there to pin behaviour that must *survive* the 4xx split, not to drive it. If you expected them red and they are green, nothing is broken; keep going.

- [ ] **Step 3: Move the cache read above the breaker gate**

In `resolveSession`, the current order is: build cookie header → breaker `isOpen` → Redis read → fetch. Swap the middle two so it reads: build cookie header → Redis read → breaker `isOpen` → fetch.

Move the whole Redis block (the `const cacheKey = …` line through its `catch`) to sit immediately before the breaker check, and move the breaker check to sit immediately after it:

```ts
    // Cache before the breaker: a hot identity needs no fetch, so it must survive a partner
    // blip that already opened the breaker.
    const cacheKey = cacheKeyFor(slug, cookieValue);
    const redis = getRedis();
    try {
        const cached = await redis.get(cacheKey);
        if (cached !== null) {
            const user = JSON.parse(cached) as BrandUser;
            return { status: 'authenticated', user };
        }
    } catch (err) {
        logger.warn({ err, slug }, '[auth] whoami cache read failed; falling through to fetch');
    }

    if (await breaker.isOpen(slug)) {
        return { status: 'unavailable', reason: 'breaker open' };
    }
```

Do **not** move the `buildCookieHeader` block. It stays above both.

- [ ] **Step 4: Split the 4xx range by what it actually means**

Replace this:

```ts
    if (response.status === 401) {
        await breaker.recordSuccess(slug); // partner answered — circuit is healthy
        return { status: 'unauthenticated' };
    }
```

with this:

```ts
    // The upstream answered about THIS session, so the circuit is healthy.
    if (response.status === 401 || response.status === 403) {
        await breaker.recordSuccess(slug);
        return { status: 'unauthenticated' };
    }

    // The rest of the 4xx range is about the REQUEST, not the session: 429 is a partner asking us
    // to back off, 400/404/405 a moved or misconfigured whoami. recordSuccess would clear the brake
    // for every replica, so these fail like any other fault — loudly.
    if (response.status >= 400 && response.status < 500) {
        logger.warn({ slug, status: response.status }, '[auth] whoami rejected the request');
        await breaker.recordFailure(slug);
        return { status: 'unavailable', reason: `whoami ${response.status}` };
    }
```

**`>= 400` is load-bearing — do not drop it.** The guards above this one return on `status === 0`, on `opaqueredirect`, on 3xx and on 401/403. **Nothing above has consumed the 2xx range**: today it is the `if (!response.ok)` branch *below* that lets a 200 through. A bare `status < 500` here therefore catches every successful whoami, turns every authenticated request into `unavailable`, and opens the breaker after three of them. node-socket writes `response.status >= 400 && response.status < 500` for exactly this reason.

Keep this branch below the 401/403 guard, and leave the existing `!response.ok` branch after it for the 5xx range.

- [ ] **Step 5: Update the step-order docstring**

The `resolveSession` docstring enumerates its steps 1-9 and states the order is a security property. Renumber steps 4 and 5 to reflect cache-then-breaker, and change step 7's description from "every redirect form is failure" to note that 4xx is a client condition. Keep the docstring's existing tone and structure; do not rewrite it.

- [ ] **Step 6: Run the tests**

Run: `pnpm test src/modules/auth/session-resolver.test.ts`
Expected: PASS, all of them — the five new ones and every pre-existing one. If a pre-existing test now fails, **do not edit it**; the change broke something real.

- [ ] **Step 7: Run the neighbors**

Run: `pnpm test src/modules/auth`
Expected: PASS. `auth.middleware.test.ts` and `whoami-breaker.test.ts` must be unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth/session-resolver.ts src/modules/auth/session-resolver.test.ts
git commit -m "fix(auth): a 4xx whoami answer is a client condition, not a partner fault

A 404 (valid session, missing mirror row) used to call recordFailure; three
in a row opened the breaker for every user of the brand. Also reads the
cache before the breaker gate so a hot identity survives a partner blip."
```

---

## Task 3: Derive the Better Auth cookie names in exactly one place

**Files:**
- Create: `src/modules/auth/abe-cookie-names.ts`
- Test: `src/modules/auth/abe-cookie-names.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type BetterAuthCookieNames = { sessionToken: string; sessionData: string }`
  - `betterAuthCookieNames(isSecure: boolean): BetterAuthCookieNames`
  - `abeCookieNamesFor(issuer: string): BetterAuthCookieNames`
  - `abeCookieNameCandidates(issuer: string): readonly BetterAuthCookieNames[]`

  Tasks 4, 6 and 7 import all four.

- [ ] **Step 1: Write the failing test**

Create `src/modules/auth/abe-cookie-names.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { abeCookieNameCandidates, abeCookieNamesFor, betterAuthCookieNames } from './abe-cookie-names.js';

describe('betterAuthCookieNames', () => {
    it('prefixes with __Secure- when secure', () => {
        expect(betterAuthCookieNames(true)).toEqual({
            sessionToken: '__Secure-better-auth.session_token',
            sessionData: '__Secure-better-auth.session_data',
        });
    });

    it('omits the prefix when not secure', () => {
        expect(betterAuthCookieNames(false)).toEqual({
            sessionToken: 'better-auth.session_token',
            sessionData: 'better-auth.session_data',
        });
    });
});

describe('abeCookieNamesFor', () => {
    it('derives secure from the issuer protocol, not from the environment', () => {
        expect(abeCookieNamesFor('https://auth.abeduls.com').sessionToken).toBe('__Secure-better-auth.session_token');
        expect(abeCookieNamesFor('http://auth.abeduls.local').sessionToken).toBe('better-auth.session_token');
    });
});

describe('abeCookieNameCandidates', () => {
    it('always returns both namespaces, the issuer-matching one first', () => {
        const secureFirst = abeCookieNameCandidates('https://auth.abeduls.com');
        expect(secureFirst).toHaveLength(2);
        expect(secureFirst[0].sessionToken).toBe('__Secure-better-auth.session_token');
        expect(secureFirst[1].sessionToken).toBe('better-auth.session_token');

        const insecureFirst = abeCookieNameCandidates('http://auth.abeduls.local');
        expect(insecureFirst[0].sessionToken).toBe('better-auth.session_token');
        expect(insecureFirst[1].sessionToken).toBe('__Secure-better-auth.session_token');
    });

    it('returns both, secure first, when the issuer is empty', () => {
        const both = abeCookieNameCandidates('');
        expect(both).toHaveLength(2);
        expect(both[0].sessionToken).toBe('__Secure-better-auth.session_token');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/modules/auth/abe-cookie-names.test.ts`
Expected: FAIL — cannot resolve `./abe-cookie-names.js`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/auth/abe-cookie-names.ts`:

```ts
export type BetterAuthCookieNames = { readonly sessionToken: string; readonly sessionData: string };

export function betterAuthCookieNames(isSecure: boolean): BetterAuthCookieNames {
    const prefix = isSecure ? '__Secure-' : '';
    return {
        sessionToken: `${prefix}better-auth.session_token`,
        sessionData: `${prefix}better-auth.session_data`,
    };
}

const isSecureIssuer = (issuer: string): boolean => issuer.startsWith('https://');

export function abeCookieNamesFor(issuer: string): BetterAuthCookieNames {
    return betterAuthCookieNames(isSecureIssuer(issuer));
}

// Both candidates, always: one guessed namespace can lock abe out or miss a mid-migration jar.
export function abeCookieNameCandidates(issuer: string): readonly BetterAuthCookieNames[] {
    const secure = betterAuthCookieNames(true);
    const insecure = betterAuthCookieNames(false);
    if (!issuer) return [secure, insecure];
    return isSecureIssuer(issuer) ? [secure, insecure] : [insecure, secure];
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test src/modules/auth/abe-cookie-names.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove this is the only derivation**

Run: `grep -rn "better-auth.session" src/`
Expected: matches only in `src/modules/auth/abe-cookie-names.ts` and the two test files. A match anywhere else means a literal was written by hand — fix it now, not later.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/abe-cookie-names.ts src/modules/auth/abe-cookie-names.test.ts
git commit -m "feat(auth): derive the Better Auth cookie names from the issuer protocol"
```

---

## Task 4: Chunk-aware cookie parsing and the two forward builders

**Files:**
- Create: `src/modules/auth/better-auth-cookies.ts`
- Test: `src/modules/auth/better-auth-cookies.test.ts`

**Interfaces:**
- Consumes: `BetterAuthCookieNames` from Task 3; `buildCookieHeader` from `src/modules/brand/identity.ts`.
- Produces:
  - `parseCookieEntries(cookieHeader: string): [string, string][]`
  - `buildBetterAuthPair(entries: readonly [string, string][], names: BetterAuthCookieNames): string | null`
  - `buildCredentialOnly(entries: readonly [string, string][], names: BetterAuthCookieNames): string | null`

  Task 7 imports all three.

**Why a new file rather than extending `extractCookieValue`:** that helper is an exact-name matcher, which is correct for `session_token` and structurally unable to find `session_data.0`/`.1`. Contract §5.2.

- [ ] **Step 1: Write the failing test**

Create `src/modules/auth/better-auth-cookies.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { betterAuthCookieNames } from './abe-cookie-names.js';
import { buildBetterAuthPair, buildCredentialOnly, parseCookieEntries } from './better-auth-cookies.js';

const names = betterAuthCookieNames(false);

describe('parseCookieEntries', () => {
    it('returns every name/value pair, trimmed and URL-decoded', () => {
        expect(parseCookieEntries('a=1; b=hello%20world')).toEqual([
            ['a', '1'],
            ['b', 'hello world'],
        ]);
    });

    it('keeps the raw value when it is not valid percent-encoding', () => {
        expect(parseCookieEntries('a=100%')).toEqual([['a', '100%']]);
    });

    it('skips entries with no "="', () => {
        expect(parseCookieEntries('a=1; garbage; b=2')).toEqual([
            ['a', '1'],
            ['b', '2'],
        ]);
    });

    it('returns an empty array for an empty header', () => {
        expect(parseCookieEntries('')).toEqual([]);
    });
});

describe('buildBetterAuthPair', () => {
    it('returns null when the credential is absent', () => {
        const entries = parseCookieEntries(`${names.sessionData}=jwt`);
        expect(buildBetterAuthPair(entries, names)).toBeNull();
    });

    it('forwards the credential alone when there is no cache cookie', () => {
        const entries = parseCookieEntries(`${names.sessionToken}=tok.sig`);
        expect(buildBetterAuthPair(entries, names)).toBe(`${names.sessionToken}=tok.sig`);
    });

    it('forwards both when the cache cookie is unchunked', () => {
        const entries = parseCookieEntries(`${names.sessionToken}=tok.sig; ${names.sessionData}=jwt`);
        expect(buildBetterAuthPair(entries, names)).toBe(
            `${names.sessionToken}=tok.sig; ${names.sessionData}=jwt`,
        );
    });

    it('reassembles chunks in NUMERIC order, not lexical', () => {
        const entries = parseCookieEntries(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.10=k; ${names.sessionData}.2=c; ${names.sessionData}.1=b; ${names.sessionData}.0=a`,
        );
        expect(buildBetterAuthPair(entries, names)).toBe(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.0=a; ${names.sessionData}.1=b; ${names.sessionData}.2=c; ${names.sessionData}.10=k`,
        );
    });

    it('ignores a non-numeric suffix on the cache cookie name', () => {
        const entries = parseCookieEntries(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.x=junk; ${names.sessionData}.0=a`,
        );
        expect(buildBetterAuthPair(entries, names)).toBe(
            `${names.sessionToken}=tok.sig; ${names.sessionData}.0=a`,
        );
    });

    it('returns null when any value carries a header delimiter', () => {
        const entries: [string, string][] = [
            [names.sessionToken, 'tok.sig'],
            [names.sessionData, 'jwt;injected=1'],
        ];
        expect(buildBetterAuthPair(entries, names)).toBeNull();
    });
});

describe('buildCredentialOnly', () => {
    it('drops the cache cookie entirely', () => {
        const entries = parseCookieEntries(`${names.sessionToken}=tok.sig; ${names.sessionData}=jwt`);
        expect(buildCredentialOnly(entries, names)).toBe(`${names.sessionToken}=tok.sig`);
    });

    it('returns null when the credential is absent', () => {
        const entries = parseCookieEntries(`${names.sessionData}=jwt`);
        expect(buildCredentialOnly(entries, names)).toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/modules/auth/better-auth-cookies.test.ts`
Expected: FAIL — cannot resolve `./better-auth-cookies.js`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/auth/better-auth-cookies.ts`:

```ts
import { buildCookieHeader } from '../brand/identity.js';
import type { BetterAuthCookieNames } from './abe-cookie-names.js';

export function parseCookieEntries(cookieHeader: string): [string, string][] {
    const entries: [string, string][] = [];
    for (const part of cookieHeader.split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) continue;
        const name = part.slice(0, separator).trim();
        if (!name) continue;
        const rawValue = part.slice(separator + 1).trim();
        let value = rawValue;
        try {
            value = decodeURIComponent(rawValue);
        } catch {
            // keep the raw value
        }
        entries.push([name, value]);
    }
    return entries;
}

export function buildBetterAuthPair(
    entries: readonly [string, string][],
    names: BetterAuthCookieNames,
): string | null {
    const token = entries.find(([name]) => name === names.sessionToken)?.[1];
    if (token === undefined) return null;

    const pairs: string[] = [];
    const push = (name: string, value: string): boolean => {
        const pair = buildCookieHeader(name, value);
        if (pair === null) return false;
        pairs.push(pair);
        return true;
    };
    if (!push(names.sessionToken, token)) return null;

    const plain = entries.find(([name]) => name === names.sessionData)?.[1];
    if (plain !== undefined) {
        if (!push(names.sessionData, plain)) return null;
    } else {
        const prefix = `${names.sessionData}.`;
        const chunks = entries
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, value]) => ({ name, value, index: Number.parseInt(name.slice(prefix.length), 10) }))
            .filter((chunk) => !Number.isNaN(chunk.index));
        for (const chunk of [...chunks].sort((a, b) => a.index - b.index)) {
            if (!push(chunk.name, chunk.value)) return null;
        }
    }
    return pairs.join('; ');
}

// Forwarded instead of the pair on credential-mismatch: capsule never checks the pair, so
// sending session_data would let it re-authenticate the very JWT we just rejected.
export function buildCredentialOnly(
    entries: readonly [string, string][],
    names: BetterAuthCookieNames,
): string | null {
    const token = entries.find(([name]) => name === names.sessionToken)?.[1];
    if (token === undefined) return null;
    return buildCookieHeader(names.sessionToken, token);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test src/modules/auth/better-auth-cookies.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/better-auth-cookies.ts src/modules/auth/better-auth-cookies.test.ts
git commit -m "feat(auth): chunk-aware Better Auth cookie parsing and forward builders"
```

---

## Task 5: Teach the brand contract about an auth origin

**Files:**
- Modify: `src/modules/brand/brand.contract.ts:31-53` (the `BrandAuthConfig` union)
- Modify: `src/modules/brand/identity.ts` (`PROTECTED_AUTH_KEYS`, `resolveValidatedWhoamiTarget`, plus a new `resolveValidatedAuthOrigin`)
- Modify: `src/modules/brand/registry.ts` (the abe entry)
- Test: `src/modules/brand/identity.test.ts`, `src/modules/brand/registry.test.ts`

**Interfaces:**
- Consumes: `isWhoamiHostAllowed`, `validateWhoamiUrl` from `src/modules/brand/identity.ts`.
- Produces:
  - `BrandAuthConfig`'s `capsule` variant gains `authIssuer: string` and `authAllowedHosts: readonly string[]`, and its `sessionCookieName` becomes optional.
  - `resolveValidatedAuthOrigin(config): { ok: true; issuer: string } | { ok: false; reason: string }`

  Tasks 6 and 7 import `resolveValidatedAuthOrigin`.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/brand/identity.test.ts`. **The file does not currently import `makeBrand`** — its existing fixtures use `getBaseBrandConfig('edo')` — so add both imports:

```ts
import { makeBrand } from '../../test-utils/fixtures.js';
import { resolveValidatedAuthOrigin } from './identity.js';

describe('resolveValidatedAuthOrigin', () => {
    const capsuleBrand = makeBrand({
        slug: 'abe',
        auth: {
            kind: 'capsule',
            authIssuer: 'https://auth.example.test',
            authAllowedHosts: ['example.test'],
        },
    });

    it('accepts an issuer inside the allowlist', () => {
        const result = resolveValidatedAuthOrigin(capsuleBrand);
        expect(result).toEqual({ ok: true, issuer: 'https://auth.example.test' });
    });

    it('rejects a partner-whoami brand — it has no auth origin', () => {
        const result = resolveValidatedAuthOrigin(makeBrand({ slug: 'edo' }));
        expect(result.ok).toBe(false);
    });

    it('rejects an issuer whose host is outside authAllowedHosts', () => {
        const evil = makeBrand({
            slug: 'abe',
            auth: {
                kind: 'capsule',
                authIssuer: 'https://auth.attacker.test',
                authAllowedHosts: ['example.test'],
            },
        });
        expect(resolveValidatedAuthOrigin(evil).ok).toBe(false);
    });

    it('rejects a non-https issuer', () => {
        const insecure = makeBrand({
            slug: 'abe',
            auth: {
                kind: 'capsule',
                authIssuer: 'http://auth.example.test',
                authAllowedHosts: ['example.test'],
            },
        });
        expect(resolveValidatedAuthOrigin(insecure).ok).toBe(false);
    });

    it('authAllowedHosts is code-only — an override can never widen it', () => {
        process.env.ABE_BRAND_OVERRIDE = JSON.stringify({ auth: { authAllowedHosts: ['attacker.test'] } });
        try {
            const result = resolveValidatedAuthOrigin(
                makeBrand({
                    slug: 'abe',
                    auth: {
                        kind: 'capsule',
                        authIssuer: 'https://auth.attacker.test',
                        authAllowedHosts: ['example.test'],
                    },
                }),
            );
            expect(result.ok).toBe(false);
        } finally {
            delete process.env.ABE_BRAND_OVERRIDE;
        }
    });

    it('an issuer override INSIDE the allowlist is honoured (per-environment origins)', () => {
        process.env.ABE_BRAND_OVERRIDE = JSON.stringify({ auth: { authIssuer: 'https://auth.staging.example.test' } });
        try {
            const result = resolveValidatedAuthOrigin(capsuleBrand);
            expect(result).toEqual({ ok: true, issuer: 'https://auth.staging.example.test' });
        } finally {
            delete process.env.ABE_BRAND_OVERRIDE;
        }
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/modules/brand/identity.test.ts`
Expected: FAIL — `resolveValidatedAuthOrigin` is not exported.

- [ ] **Step 3: Extend the contract type**

`src/modules/brand/brand.contract.ts`, the `capsule` variant of `BrandAuthConfig`:

```ts
    | {
          readonly kind: 'capsule';
          readonly signInUrl: string;
          readonly signOutUrl?: string;
          readonly whoamiUrl: string;
          readonly whoamiAllowedHosts: readonly string[];
          // Absent by design: the names are derived from authIssuer's protocol, never configured.
          readonly sessionCookieName?: string;
          readonly authIssuer: string;
          readonly authAllowedHosts: readonly string[];
          readonly responseMapping: BrandResponseMapping;
          readonly requireVerifiedEmail?: boolean;
      }
```

Leave the `partner-whoami` variant exactly as it is — `sessionCookieName` stays required there.

- [ ] **Step 4: Protect the new allowlist and add the resolver**

`src/modules/brand/identity.ts` — add `authAllowedHosts` to the protected set:

```ts
const PROTECTED_AUTH_KEYS = new Set(['kind', 'whoamiAllowedHosts', 'requireVerifiedEmail', 'authAllowedHosts']);
```

Then add, next to `resolveValidatedWhoamiTarget`:

```ts
export type ValidatedAuthOrigin =
    | { ok: true; issuer: string }
    | { ok: false; reason: string };

/**
 * The auth-origin analogue of resolveValidatedWhoamiTarget. authIssuer is an overridable string,
 * so it is gated by the code-only authAllowedHosts — an unvalidated issuer override points the
 * verifier at an attacker's JWKS, which then mints `valid` for anything.
 */
export function resolveValidatedAuthOrigin(config: CompanionBrandConfig): ValidatedAuthOrigin {
    const eff = resolveEffectiveAuth(config);
    if (eff.kind !== 'capsule') return { ok: false, reason: 'brand has no auth origin' };

    const issuer = validateWhoamiUrl(eff.authIssuer, eff.authAllowedHosts);
    if (!issuer.ok) return { ok: false, reason: `authIssuer: ${issuer.reason}` };

    // The raw value, not issuer.url: the iss claim must match auth-service byte for byte, and
    // URL() normalizes (a trailing slash, a lowercased host) in ways that would silently miss.
    return { ok: true, issuer: eff.authIssuer };
}
```

`validateWhoamiUrl` already enforces https, no credentials, no non-default port and the suffix allowlist — reuse it rather than writing a second validator. The JWKS URL is derived from the issuer inside the verifier (Task 6); there is no second field to keep in sync.

- [ ] **Step 5: Widen the two places that assume a cookie name always exists**

Making the capsule variant's `sessionCookieName` optional breaks two signatures in `src/modules/brand/identity.ts` under `strict` — `pnpm typecheck` fails at Step 9 unless both are widened.

**(a) `ValidatedWhoamiTarget`** declares `sessionCookieName: string`. Change that member to `sessionCookieName?: string`.

**(b) `resolveEffectiveSessionCookieName`** (`identity.ts:158-160`) declares `: string` and returns `resolveEffectiveAuth(config).sessionCookieName`, which is now `string | undefined`:

```ts
export function resolveEffectiveSessionCookieName(config: CompanionBrandConfig): string | undefined {
    return resolveEffectiveAuth(config).sessionCookieName;
}
```

Its two existing assertions in `identity.test.ts:159,164` are edo-only and keep passing. Task 7's partner branch still calls it, so the symbol stays in use — do not delete it or its import.

- [ ] **Step 6: Update the Zod schema — without this the service does not boot**

`src/modules/brand/brand.schema.ts` is the runtime mirror of the type you just changed, and `src/modules/brand/brand.service.ts:40` runs `companionBrandConfigSchema.parse(base)` inside `resolveBrand()` — at process start, for every servable brand. The schema's `authSharedFields` (`brand.schema.ts:28-35`) is spread into **both** union members, both `.strict()`, and it makes `sessionCookieName` required. So the abe entry from Step 7 would throw twice over: an unknown key (`authIssuer`) and a missing required one (`sessionCookieName`). Companion would fail to start.

Split the shared fields so the two kinds can differ:

```ts
const authSharedFields = {
    signInUrl: z.string(),
    signOutUrl: z.string().optional(),
    whoamiUrl: z.string(),
    whoamiAllowedHosts: z.array(z.string()),
    responseMapping: brandResponseMappingSchema,
    requireVerifiedEmail: z.boolean().optional(),
};

export const brandAuthConfigSchema = z.discriminatedUnion('kind', [
    z
        .object({
            kind: z.literal('capsule'),
            ...authSharedFields,
            // Derived from authIssuer's protocol, never configured.
            sessionCookieName: z.string().min(1).optional(),
            authIssuer: z.string(),
            authAllowedHosts: z.array(z.string()),
        })
        .strict(),
    z
        .object({
            kind: z.literal('partner-whoami'),
            ...authSharedFields,
            sessionCookieName: z.string().min(1),
        })
        .strict(),
]);
```

`sessionCookieName` stays **required** on `partner-whoami` — edo and picaboo depend on it, and Task 7's partner branch reads it.

`brandOverrideAuthSchema` (`brand.schema.ts:116-125`) is `.passthrough()`, so the `authIssuer` override in `.env.example` needs **no** change there. Do not add it — that would widen the override surface for no reason.

- [ ] **Step 7: Flip the abe registry entry**

`src/modules/brand/registry.ts`, the abe `auth` block:

```ts
        auth: {
            kind: 'capsule',
            signInUrl: 'https://www.abeduls.com/sign-in',
            whoamiUrl: 'https://www.abeduls.com/api/user',
            whoamiAllowedHosts: ['www.abeduls.com'],
            authIssuer: 'https://auth.abeduls.com',
            authAllowedHosts: ['abeduls.com'],
            responseMapping: { idField: 'id', emailField: 'email', nameField: 'displayName', imageField: 'imageUrl' },
            requireVerifiedEmail: true,
        },
```

Delete `sessionCookieName: 'abes_session'` and the comment above the block that calls `kind` cosmetic — `kind` is the branch selector now. Replace it with one line:

```ts
            // kind selects the resolver branch: capsule verifies session_data locally, partners always forward.
```

Note `authAllowedHosts` is the bare registrable domain `abeduls.com`, not `www.abeduls.com`, because the auth origin is `auth.abeduls.com`. The suffix matcher (`h === e || h.endsWith('.' + e)`) accepts it.

- [ ] **Step 8: Run the brand tests**

Run: `pnpm test src/modules/brand`
Expected: PASS.

Two existing assertions describe the OLD contract and this task is the one that changes it, so update them:
- `registry.test.ts:82` — `expect(abe.auth.sessionCookieName).toBe('abes_session')`. The field is gone; assert `abe.auth.kind === 'capsule'` and `abe.auth.authIssuer` instead.
- Anything in `registry.test.ts` or `brand.schema.test.ts` asserting `companionBrandConfigSchema.parse(abe)` does not throw must still pass — if it now throws, Step 6 was not applied correctly. That is the single most important assertion in this task.

Do not update any assertion about `edo` or `picaboo`.

- [ ] **Step 9: Verify the brand config end to end**

Run: `npx tsx scripts/verify-brand-config.ts`
Expected: abe resolves with `kind: 'capsule'` and the new auth-origin fields, and no override-rejection warnings.

- [ ] **Step 10: Typecheck and commit**

```bash
pnpm typecheck
git add src/modules/brand/
git commit -m "feat(brand): abe is a capsule brand with a gated auth origin

abes_session no longer exists; the cookie names are derived from authIssuer's
protocol. authAllowedHosts is code-only so an override cannot repoint the issuer."
```

---

## Task 6: Vendor the verifier and wrap it

**Files:**
- Create: `src/vendor/auth-verify/{index,jwks,sessionCookie,verify}.ts` — copied, never authored
- Create: `src/vendor/auth-verify/VENDORED.md`, `src/vendor/auth-verify/MANIFEST.sha256`
- Create: `src/vendor/auth-verify/vendor-integrity.test.ts`
- Create: `src/modules/auth/abe-session-verifier.ts`
- Test: `src/modules/auth/abe-session-verifier.test.ts`
- Modify: `package.json` (add `jose`), `biome.json`, `vitest.config.ts`

**Interfaces:**
- Consumes: `verifySessionCookie`, `createJwksCache` from the vendored copy; `abeCookieNamesFor` (Task 3); `resolveValidatedAuthOrigin`, `PARTNER_ID_PATTERN` (Task 5).
- Produces:
  - `type AbeSessionResult = { status: 'valid'; user: BrandUser; emailVerified: boolean } | { status: 'miss'; cause: 'absent' | 'expired' | 'poisoned' | 'unavailable' | 'credential-mismatch' }`
  - `createAbeSessionVerifier(brand: Brand): AbeSessionVerifier | null` — the factory. `null` when the brand has no valid auth origin, which degrades cleanly to the whoami path.
  - `getAbeSessionVerifier(brand: Brand): AbeSessionVerifier | null` — the memoized accessor production code calls, so one JWKS cache serves every request.
  - `interface AbeSessionVerifier { verify(cookieHeader: string | undefined | null): Promise<AbeSessionResult> }`

  Task 7 imports `getAbeSessionVerifier` and the two types.

**The `valid` variant carries a complete `BrandUser`, not just an id.** The JWT's `user` claim already holds `{ id, email, emailVerified, name, image }` (contract §1's claim table), and `BrandUser` is `{ id, email, displayName, imageUrl }`. A locally-verified user must be indistinguishable from a whoami-verified one downstream — `buildS3Key` reads `id`, but logging and `enrich-edo` read the rest. No `responseMapping` is involved: whoami responses have per-brand field names, the JWT's claims do not.

- [ ] **Step 1: Copy the source, byte-identically**

```bash
mkdir -p src/vendor/auth-verify
cp <abeduls3>/packages/auth-verify/src/*.ts src/vendor/auth-verify/
```

Four files: `index.ts` (10 lines), `jwks.ts` (55), `sessionCookie.ts` (201), `verify.ts` (53).

**Copy `src/` only — never `tests/`.** The upstream tests import extensionlessly (`'../src/jwks'`), which this repo's `moduleResolution: NodeNext` rejects, and they would add sync surface for no gain. Upstream owns its tests.

**Carry `verify.ts` even though nothing here calls it.** It is the bearer-token path and has no production caller anywhere yet. A partial copy reopens the "which files?" question at every future sync; dead exports in a vendored directory are normal.

- [ ] **Step 2: Prove the copy is identical**

```bash
diff -r <abeduls3>/packages/auth-verify/src src/vendor/auth-verify
```

Expected: **no output**, except for the files Step 4 and Step 5 add (`VENDORED.md`, `MANIFEST.sha256`) and the test from Step 5, which `diff` will report as "Only in src/vendor/auth-verify". Nothing else. If `diff` reports a content difference on a `.ts` file at any point after this, something reformatted them — that is what Step 3 prevents.

This command is the entire sync-verification story. Every later decision in this task exists to keep it meaningful.

- [ ] **Step 3: Stop the toolchain from rewriting the copy**

Three of this repo's defaults touch `src/**` and would each break the copy or the build. All three fixes are one line.

**(a) Biome would reformat it.** `biome.json` sets `files.includes: ["**", "!!dist", "!!coverage", "!!docs/legacy"]` with a 4-space formatter; upstream uses 2 spaces. `pnpm format` would rewrite all four files and destroy byte-identity, and `biome check` would lint foreign code under `recommended`. Add the exclusion:

```json
    "files": {
        "includes": ["**", "!!dist", "!!coverage", "!!docs/legacy", "!!src/vendor"]
    },
```

**(b) Coverage would count it.** `vitest.config.ts` has `include: ['src/**/*.ts']` and a 70% line threshold. Task 7 mocks the vendored module, so ~319 lines would land near 0% and could tip the gate red for reasons unrelated to the change. Add to the `exclude` array, next to `'src/test-utils/**'`:

```ts
                'src/vendor/**',
```

**(c) The typecheck already covers it, and that is correct.** `tsconfig.json`'s `include` is `src/**/*`, so the vendored files are typechecked — keep it that way. It is how you learn the copy compiles under this repo's TypeScript settings, which upstream's own config cannot tell you.

- [ ] **Step 4: Write the sync record**

Create `src/vendor/auth-verify/VENDORED.md`. **It goes in this sibling file and not inside the `.ts` sources** — a header comment there would break Step 2's `diff`, which is the one check that makes hand-syncing safe.

```markdown
# Vendored: auth-verify

Copied verbatim from abeduls3. **Do not edit any `.ts` file in this directory.**

| | |
|---|---|
| Upstream repo | `git@github.com:manunoly/abeduls3.git` |
| Upstream path | `packages/auth-verify/src/` |
| Synced at commit | `<full 40-char SHA>` |
| Synced on | `<YYYY-MM-DD>` |
| Validated against | `better-auth@1.7.2` (upstream's `tests/betterAuthConformance.test.ts` at that commit) |
| Runtime dependency | `jose@^6.2.10` |

## Re-sync

```bash
cp <abeduls3>/packages/auth-verify/src/*.ts src/vendor/auth-verify/
(cd src/vendor/auth-verify && sha256sum *.ts > MANIFEST.sha256)
```

Then update the table above and run `pnpm test src/vendor`.

## Verify this copy is current

```bash
diff -r <abeduls3>/packages/auth-verify/src src/vendor/auth-verify
```

No output on the `.ts` files means in sync.

## Why you must not edit these files

A fix made here is overwritten by the next sync and, until then, silently diverges this
service's authentication from every other service in the fleet — one accepting what another
rejects, with no error anywhere. Fix it in abeduls3 first, then re-sync.

`better-auth` is the thing that actually drifts: a version bump in `auth-service` can change
the cookie's wire format. Upstream's conformance test diffs this code against
`better-auth/cookies`' own `getCookieCache`, so such a change fails there first.
```

Use the **full 40-character** SHA, not a short one — a short SHA is ambiguous across repos and useless to `git show` years later.

- [ ] **Step 5: Write the failing integrity test**

This is what makes "do not edit" enforceable in CI rather than aspirational. Create `src/vendor/auth-verify/vendor-integrity.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

// Enforces VENDORED.md's "do not edit": a hand edit here changes a hash and fails CI.
describe('vendored auth-verify integrity', () => {
    it('every .ts file matches MANIFEST.sha256', () => {
        const manifest = new Map(
            readFileSync(join(here, 'MANIFEST.sha256'), 'utf8')
                .split('\n')
                .filter((line) => line.trim() !== '')
                .map((line) => {
                    const [hash, name] = line.trim().split(/\s+/);
                    return [name.replace(/^\*/, ''), hash] as const;
                }),
        );

        const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
        expect(sources.sort()).toEqual(['index.ts', 'jwks.ts', 'sessionCookie.ts', 'verify.ts']);

        for (const name of sources) {
            const actual = createHash('sha256').update(readFileSync(join(here, name))).digest('hex');
            expect(actual, `${name} was modified — fix it upstream and re-sync`).toBe(manifest.get(name));
        }
    });
});
```

The filename assertion matters as much as the hashes: it catches a file added to or removed from the directory, which a hash check alone would miss.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm test src/vendor`
Expected: FAIL — `MANIFEST.sha256` does not exist yet (`ENOENT`).

- [ ] **Step 7: Generate the manifest and make it pass**

```bash
(cd src/vendor/auth-verify && sha256sum *.ts > MANIFEST.sha256)
```

Run: `pnpm test src/vendor`
Expected: PASS.

Then prove the test actually bites — append a space to `jwks.ts`, re-run, confirm FAIL, and revert. A guard nobody has seen fail is a guard nobody can trust.

- [ ] **Step 8: Add the one real dependency**

```bash
pnpm add jose
```

Expected: `jose@^6.2.10` or compatible. Nothing else is added — the vendored code imports only `jose` and a type from `node:crypto`.

- [ ] **Step 9: Write the failing verifier test**

Create `src/modules/auth/abe-session-verifier.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBrand } from '../../test-utils/fixtures.js';

const verifySessionCookie = vi.fn();
vi.mock('../../vendor/auth-verify/index.js', () => ({
    createJwksCache: vi.fn(() => ({ get: vi.fn(), refresh: vi.fn() })),
    verifySessionCookie: (...args: unknown[]) => verifySessionCookie(...args),
}));

const { createAbeSessionVerifier, getAbeSessionVerifier } = await import('./abe-session-verifier.js');

const abe = makeBrand({
    slug: 'abe',
    auth: {
        kind: 'capsule',
        authIssuer: 'https://auth.example.test',
        authAllowedHosts: ['example.test'],
    },
});

describe('createAbeSessionVerifier', () => {
    beforeEach(() => {
        verifySessionCookie.mockReset();
    });

    it('returns null for a brand with no valid auth origin', () => {
        expect(createAbeSessionVerifier(makeBrand({ slug: 'edo' }))).toBeNull();
    });

    it('getAbeSessionVerifier returns the SAME instance across calls (the JWKS cache must outlive the request)', () => {
        const first = getAbeSessionVerifier(abe);
        const second = getAbeSessionVerifier(abe);

        expect(first).not.toBeNull();
        expect(second).toBe(first);
    });

    it('getAbeSessionVerifier returns a NEW instance when the issuer changes', () => {
        const first = getAbeSessionVerifier(abe);
        const moved = makeBrand({
            slug: 'abe',
            auth: { ...abe.auth, authIssuer: 'https://auth2.example.test' },
        });

        expect(getAbeSessionVerifier(moved)).not.toBe(first);
    });

    it('maps a valid result to a complete BrandUser plus the verified-email claim', async () => {
        verifySessionCookie.mockResolvedValue({
            status: 'valid',
            user: { id: 'u1', email: 'a@b.test', emailVerified: true, name: 'Ada', image: 'https://img.test/a.png' },
            session: {},
        });

        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier!.verify('better-auth.session_token=t');

        expect(result).toEqual({
            status: 'valid',
            user: { id: 'u1', email: 'a@b.test', displayName: 'Ada', imageUrl: 'https://img.test/a.png' },
            emailVerified: true,
        });
    });

    it('a null name and image become null, not the string "null"', async () => {
        verifySessionCookie.mockResolvedValue({
            status: 'valid',
            user: { id: 'u1', email: 'a@b.test', emailVerified: false, name: null, image: null },
            session: {},
        });

        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier!.verify('better-auth.session_token=t');

        expect(result).toEqual({
            status: 'valid',
            user: { id: 'u1', email: 'a@b.test', displayName: null, imageUrl: null },
            emailVerified: false,
        });
    });

    it('an id that fails PARTNER_ID_PATTERN is poisoned, not valid', async () => {
        verifySessionCookie.mockResolvedValue({
            status: 'valid',
            user: { id: 'has spaces and/slashes', email: 'a@b.test', emailVerified: true },
            session: {},
        });

        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier!.verify('better-auth.session_token=t');

        expect(result).toEqual({ status: 'miss', cause: 'poisoned' });
    });

    it('an email with no @ is poisoned, not valid', async () => {
        verifySessionCookie.mockResolvedValue({
            status: 'valid',
            user: { id: 'u1', email: 'not-an-email', emailVerified: true },
            session: {},
        });

        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier!.verify('better-auth.session_token=t');

        expect(result).toEqual({ status: 'miss', cause: 'poisoned' });
    });

    it.each(['absent', 'expired', 'poisoned', 'credential-mismatch', 'unavailable'] as const)(
        'passes %s through as a miss cause',
        async (status) => {
            verifySessionCookie.mockResolvedValue({ status });

            const verifier = createAbeSessionVerifier(abe);
            const result = await verifier!.verify('better-auth.session_token=t');

            expect(result).toEqual({ status: 'miss', cause: status });
        },
    );

    it('an absent cookie header is a miss without calling the verifier', async () => {
        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier!.verify(undefined);

        expect(result).toEqual({ status: 'miss', cause: 'absent' });
        expect(verifySessionCookie).not.toHaveBeenCalled();
    });

    it('a header Headers() rejects is poisoned, not unavailable', async () => {
        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier!.verify('bad\nheader=1');

        expect(result).toEqual({ status: 'miss', cause: 'poisoned' });
        expect(verifySessionCookie).not.toHaveBeenCalled();
    });
});
```

That last case matters: a malformed header is a client condition. Reporting it as `unavailable` would make Task 7 skip the breaker for a reason that has nothing to do with infrastructure.

- [ ] **Step 10: Run to verify it fails**

Run: `pnpm test src/modules/auth/abe-session-verifier.test.ts`
Expected: FAIL — cannot resolve `./abe-session-verifier.js`.

- [ ] **Step 11: Write the implementation**

Create `src/modules/auth/abe-session-verifier.ts`:

```ts
import type { Brand, BrandUser } from '../brand/brand.contract.js';
import { PARTNER_ID_PATTERN, resolveValidatedAuthOrigin } from '../brand/identity.js';
import { logger } from '../../lib/logger.js';
import { createJwksCache, verifySessionCookie } from '../../vendor/auth-verify/index.js';
import { abeCookieNamesFor } from './abe-cookie-names.js';

export type AbeSessionResult =
    | { status: 'valid'; user: BrandUser; emailVerified: boolean }
    | { status: 'miss'; cause: 'absent' | 'expired' | 'poisoned' | 'unavailable' | 'credential-mismatch' };

export interface AbeSessionVerifier {
    verify(cookieHeader: string | undefined | null): Promise<AbeSessionResult>;
}

export function createAbeSessionVerifier(brand: Brand): AbeSessionVerifier | null {
    const origin = resolveValidatedAuthOrigin(brand);
    if (!origin.ok) {
        logger.warn({ slug: brand.slug, reason: origin.reason }, '[auth] no abe auth origin; local verification is off');
        return null;
    }

    const jwks = createJwksCache({ authOrigin: origin.issuer });
    const { sessionToken: sessionTokenName, sessionData: sessionDataName } = abeCookieNamesFor(origin.issuer);

    return {
        async verify(cookieHeader) {
            if (!cookieHeader) return { status: 'miss', cause: 'absent' };

            let headers: Headers;
            try {
                headers = new Headers({ cookie: cookieHeader });
            } catch {
                return { status: 'miss', cause: 'poisoned' };
            }

            const result = await verifySessionCookie(headers, {
                jwks,
                issuer: origin.issuer,
                sessionDataName,
                sessionTokenName,
            });
            if (result.status !== 'valid') return { status: 'miss', cause: result.status };

            // The same shape guards normalizeBrandUser applies to a whoami response, so a locally
            // verified user is never less validated than a remotely verified one.
            const { id, email, name, image } = result.user;
            if (!PARTNER_ID_PATTERN.test(id) || !email.includes('@')) {
                return { status: 'miss', cause: 'poisoned' };
            }

            return {
                status: 'valid',
                user: {
                    id,
                    email,
                    displayName: typeof name === 'string' ? name : null,
                    imageUrl: typeof image === 'string' ? image : null,
                },
                emailVerified: result.user.emailVerified === true,
            };
        },
    };
}
```

`PARTNER_ID_PATTERN` is already exported from `src/modules/brand/identity.ts` (`/^[A-Za-z0-9_-]{1,64}$/`). Import it rather than restating the regex — a second copy is a second thing to keep in sync with the S3 key builder's assumptions.

- [ ] **Step 12: Memoize the verifier so the JWKS cache outlives the request**

`createJwksCache` holds the fetched key set in a closure. Calling `createAbeSessionVerifier` per request would therefore build an empty cache every time and refetch the JWKS on every single request — the exact failure contract §3.4 exists to prevent, and it would be invisible except as auth-origin traffic.

Append to `src/modules/auth/abe-session-verifier.ts`:

```ts
const verifiers = new Map<string, AbeSessionVerifier>();

// createJwksCache keeps the key set in a closure, so one instance per (brand, issuer) must
// outlive the request. Keyed on the resolved issuer so an override change still takes effect.
export function getAbeSessionVerifier(brand: Brand): AbeSessionVerifier | null {
    const origin = resolveValidatedAuthOrigin(brand);
    if (!origin.ok) return null;

    const key = `${brand.slug}|${origin.issuer}`;
    const cached = verifiers.get(key);
    if (cached) return cached;

    const created = createAbeSessionVerifier(brand);
    if (created) verifiers.set(key, created);
    return created;
}
```

The map is unbounded in principle and bounded in practice: its key space is the number of brands times the number of distinct issuers they have been configured with in this process's lifetime — three brands, one issuer each. Do not add eviction to a map that cannot grow.

`createAbeSessionVerifier` stays exported for the tests that drive it directly. Production code calls `getAbeSessionVerifier`.

- [ ] **Step 13: Run the test**

Run: `pnpm test src/modules/auth/abe-session-verifier.test.ts`
Expected: PASS, every case — including the two memoization tests, which Step 12 is what makes green.

- [ ] **Step 14: Prove the copy actually runs here, not just that it hashes correctly**

The integrity test proves the bytes are upstream's. It cannot prove they compile and run under *this* repo's Node, `tsconfig` and `jose` version. One unmocked case closes that gap. Append to `src/modules/auth/abe-session-verifier.test.ts`, in its own `describe` that does **not** use the module mock:

```ts
describe('vendored verifier, unmocked', () => {
    it('verifies a real EdDSA session_data bound to its credential', async () => {
        const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
        const { verifySessionCookie } = await vi.importActual<typeof import('../../vendor/auth-verify/index.js')>(
            '../../vendor/auth-verify/index.js',
        );

        const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
        const jwk = { ...(await exportJWK(publicKey)), alg: 'EdDSA', kid: 'k1' };
        const issuer = 'https://auth.example.test';
        const token = 'tok';

        const jwt = await new SignJWT({
            user: { id: 'u1', email: 'a@b.test', emailVerified: true },
            session: { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
        })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'k1', typ: 'better-auth.session-cache+jwt' })
            .setIssuer(issuer)
            .setAudience('better-auth:session-cache')
            .setSubject('u1')
            .setExpirationTime('5m')
            .sign(privateKey);

        const headers = new Headers({
            cookie: `better-auth.session_token=${token}.sig; better-auth.session_data=${jwt}`,
        });

        const result = await verifySessionCookie(headers, {
            jwks: { get: async () => ({ keys: [jwk] }), refresh: async () => ({ keys: [jwk] }) },
            issuer,
            sessionDataName: 'better-auth.session_data',
            sessionTokenName: 'better-auth.session_token',
        });

        expect(result.status).toBe('valid');
    });

    it('rejects the same JWT presented with a foreign credential', async () => {
        // Identical to the case above except for the session_token value — this is the bypass
        // from contract §3.1, and the one behaviour that must never regress.
        // Reuse the mint above; assert result.status === 'credential-mismatch'.
    });
});
```

Fill in the second case by copying the first and changing only the `session_token` cookie value. Do not leave it as a comment — a placeholder here is the one test whose absence nobody notices.

If `jose`'s `generateKeyPair` signature differs in the installed version, read `<abeduls3>/packages/auth-verify/tests/sessionCookie.test.ts` and borrow its minting helper verbatim rather than guessing.

- [ ] **Step 15: Full typecheck, lint and commit**

```bash
pnpm typecheck
pnpm lint
pnpm test src/vendor src/modules/auth
```

`pnpm lint` must not report anything under `src/vendor` — if it does, Step 3(a) was not applied.

```bash
git add src/vendor/ src/modules/auth/abe-session-verifier.ts src/modules/auth/abe-session-verifier.test.ts package.json pnpm-lock.yaml biome.json vitest.config.ts
git commit -m "feat(auth): vendor auth-verify and wrap it for abe local verification

Byte-identical copy of abeduls3 packages/auth-verify/src, pinned in VENDORED.md
and enforced by a hash manifest. Excluded from biome and coverage so the
toolchain cannot rewrite it."
```

---

## Task 7: Wire the abe branch into `resolveSession`

**Files:**
- Modify: `src/modules/auth/session-resolver.ts`
- Test: `src/modules/auth/session-resolver.test.ts`

**Interfaces:**
- Consumes: `getAbeSessionVerifier`/`AbeSessionVerifier` (Task 6), `abeCookieNameCandidates` (Task 3), `parseCookieEntries`/`buildBetterAuthPair`/`buildCredentialOnly` (Task 4).
- Produces: the unchanged `SessionResolution` union. The six verifier states stay inside this function and never leak to `auth.middleware.ts`.

**The branch, in order** (contract §5.1):

```
1.  Credential presence, per brand kind    <- abe: the DERIVED names; partner: unchanged
        none present -> unauthenticated    MUST stay above the SSRF gate (see below)
2.  SSRF gate (resolveValidatedWhoamiTarget)                           unchanged position
3.  build the forwarded header — client error -> unauthenticated       unchanged
3b. [NEW, abe only] verify locally
        valid                   -> authenticated, no Redis, no fetch, no breaker
        unavailable             -> log warn, fall through. Do NOT touch the breaker
        credential-mismatch     -> fall through, forwarding the CREDENTIAL ALONE
        absent|expired|poisoned -> fall through
4.  Redis cache read (45 s)                                            (Task 2 order)
5.  breaker gate                                                       (Task 2 order)
6-9. fetch, status, body cap, normalize, verified-email gate           unchanged
```

**Step 1 must stay above step 2, for both kinds.** Today `resolveSession` extracts the cookie first and returns `unauthenticated` when it is absent, so the SSRF gate is never reached by an anonymous request. Hoisting the gate above it would make an anonymous request against a brand with a broken `whoamiUrl` answer `misconfigured` — which `requireAuth` maps to **403** instead of **401**. That brand exists: `picaboo` ships `whoamiUrl: ''` by design (`registry.ts:108`), so every anonymous request to it would change status code. No current test covers "no cookie + misconfigured brand", so nothing would catch it.

This is why the code below calls `resolveValidatedWhoamiTarget` **inside** each branch rather than once at the top. The duplication is deliberate; the ordering is the security property this plan keeps claiming it preserves.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/auth/session-resolver.test.ts`. Import `makeUser` alongside the existing `makeBrand` import, and add the verifier mock beside the existing mocks at the top of the file:

```ts
const abeVerify = vi.fn();
vi.mock('./abe-session-verifier.js', () => ({
    getAbeSessionVerifier: vi.fn(() => ({ verify: (...args: unknown[]) => abeVerify(...args) })),
}));
```

and the cases:

```ts
describe('resolveSession — abe (kind: capsule)', () => {
    const abe = makeBrand({
        slug: 'abe',
        auth: {
            kind: 'capsule',
            whoamiUrl: 'https://api.test.example.com/auth/me',
            whoamiAllowedHosts: ['test.example.com'],
            authIssuer: 'https://auth.test.example.com',
            authAllowedHosts: ['test.example.com'],
        },
    });
    const token = '__Secure-better-auth.session_token=tok.sig';

    beforeEach(() => {
        abeVerify.mockReset();
    });

    it('no Better Auth credential at all -> unauthenticated, nothing else runs', async () => {
        const result = await resolveSession(abe, 'unrelated=1');

        expect(result.status).toBe('unauthenticated');
        expect(abeVerify).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('a locally valid session resolves with NO fetch, NO cache and NO breaker', async () => {
        // The shape Task 6 actually returns — a complete BrandUser, not a bare id. Asserting only
        // on `status` here would let `user: undefined` through green.
        const user = makeUser({ id: 'u1' });
        abeVerify.mockResolvedValue({ status: 'valid', user, emailVerified: true });

        const result = await resolveSession(abe, token);

        expect(result).toEqual({ status: 'authenticated', user });
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(breaker.isOpen).not.toHaveBeenCalled();
    });

    it('requireVerifiedEmail rejects a locally valid session with an unverified email', async () => {
        abeVerify.mockResolvedValue({ status: 'valid', user: makeUser({ id: 'u1' }), emailVerified: false });
        const gated = makeBrand({ slug: 'abe', auth: { ...abe.auth, requireVerifiedEmail: true } });

        const result = await resolveSession(gated, token);

        expect(result.status).toBe('unauthenticated');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('unavailable falls through to the whoami and NEVER touches the breaker for the local failure', async () => {
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'unavailable' });
        vi.mocked(globalThis.fetch).mockResolvedValue(
            new Response(JSON.stringify({ id: 'u1', email: 'a@b.test', displayName: 'A', imageUrl: null }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const result = await resolveSession(abe, token);

        expect(result.status).toBe('authenticated');
        expect(globalThis.fetch).toHaveBeenCalled();
        expect(breaker.recordFailure).not.toHaveBeenCalled();
    });

    it('poisoned falls through to the whoami and forwards BOTH cookies', async () => {
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'poisoned' });
        vi.mocked(globalThis.fetch).mockResolvedValue(
            new Response(JSON.stringify({ id: 'u1', email: 'a@b.test', displayName: 'A', imageUrl: null }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        await resolveSession(abe, `${token}; __Secure-better-auth.session_data=jwt`);

        const forwarded = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_token=tok.sig');
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_data=jwt');
    });

    it('credential-mismatch forwards the CREDENTIAL ALONE — never the distrusted cache', async () => {
        abeVerify.mockResolvedValue({ status: 'miss', cause: 'credential-mismatch' });
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 401 }));

        await resolveSession(abe, `${token}; __Secure-better-auth.session_data=jwt`);

        const forwarded = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(forwarded.Cookie).toContain('__Secure-better-auth.session_token=tok.sig');
        expect(forwarded.Cookie).not.toContain('session_data');
    });

    it('an anonymous request against a MISCONFIGURED brand is 401-shaped, not 403-shaped', async () => {
        // Pins the ordering property: credential presence is checked before the SSRF gate, so a
        // request with no cookie answers `unauthenticated`, never `misconfigured`. picaboo ships
        // whoamiUrl: '' by design, so this is its normal anonymous path.
        const broken = makeBrand({ slug: 'abe', auth: { ...abe.auth, whoamiUrl: '' } });

        expect((await resolveSession(broken, 'unrelated=1')).status).toBe('unauthenticated');
        expect((await resolveSession(makeBrand({ slug: 'edo', auth: { whoamiUrl: '' } }), 'nothing=1')).status).toBe(
            'unauthenticated',
        );
    });

    it('both cookie namespaces present -> the whoami decides, no local verify', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 401 }));

        await resolveSession(abe, `${token}; better-auth.session_token=other.sig`);

        expect(abeVerify).not.toHaveBeenCalled();
        expect(globalThis.fetch).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test src/modules/auth/session-resolver.test.ts`
Expected: the new `describe` block FAILS; every pre-existing test still PASSES.

- [ ] **Step 3: Split step 1 of `resolveSession` by brand kind**

Add the imports this branch needs at the top of `src/modules/auth/session-resolver.ts`:

```ts
import { resolveValidatedAuthOrigin } from '../brand/identity.js';
import { abeCookieNameCandidates } from './abe-cookie-names.js';
import { buildBetterAuthPair, buildCredentialOnly, parseCookieEntries } from './better-auth-cookies.js';
import { getAbeSessionVerifier } from './abe-session-verifier.js';
```

`resolveEffectiveAuth` and `buildCookieHeader` are already imported from `../brand/identity.js` — extend that import rather than adding a second one.

Replace the opening of `resolveSession` (the `cookieName`/`cookieValue`/`forwardedCookie` sequence) with a branch that produces the same three locals the rest of the function already uses — `builtCookieHeader` and `cacheHashSource` — mirroring node-socket:

```ts
    let builtCookieHeader: string;
    let cacheHashSource: string;
    let whoamiUrl: URL;

    if (brand.auth.kind === 'capsule') {
        // An unvalidated issuer yields both namespaces rather than a guess: the forward still works,
        // the whoami still decides, and a misconfigured origin degrades instead of locking abe out.
        const authOrigin = resolveValidatedAuthOrigin(brand);
        const candidates = abeCookieNameCandidates(authOrigin.ok ? authOrigin.issuer : '');
        const entries = parseCookieEntries(cookieHeader ?? '');

        // Same validity test the forward uses, so an unforwardable token cannot count toward ambiguity.
        const matchedTokens = candidates
            .map((names) => {
                const value = entries.find(([name]) => name === names.sessionToken)?.[1];
                if (value === undefined || value === '') return undefined;
                return buildCookieHeader(names.sessionToken, value) === null ? undefined : value;
            })
            .filter((value): value is string => value !== undefined);
        if (matchedTokens.length === 0) return { status: 'unauthenticated' };

        // SSRF gate, AFTER the credential check — see the ordering note above.
        const target = resolveValidatedWhoamiTarget(brand);
        if (!target.ok) {
            logger.error({ slug, reason: target.reason }, '[auth] whoami target misconfigured');
            return { status: 'misconfigured', reason: target.reason };
        }
        whoamiUrl = target.whoamiUrl;

        let credentialOnly = false;
        if (matchedTokens.length === 1) {
            const verifier = getAbeSessionVerifier(brand);
            if (verifier) {
                const verified = await verifier.verify(cookieHeader);
                if (verified.status === 'valid') {
                    const effectiveAuth = resolveEffectiveAuth(brand);
                    if (effectiveAuth.requireVerifiedEmail && !verified.emailVerified) {
                        return { status: 'unauthenticated' };
                    }
                    return { status: 'authenticated', user: verified.user };
                }
                if (verified.cause === 'unavailable') {
                    logger.warn({ slug }, '[auth] abe local verification unavailable (JWKS unreachable)');
                } else if (verified.cause === 'credential-mismatch') {
                    credentialOnly = true;
                }
            }
        }

        const forwards = candidates
            .map((names) => (credentialOnly ? buildCredentialOnly(entries, names) : buildBetterAuthPair(entries, names)))
            .filter((pair): pair is string => pair !== null);
        if (forwards.length === 0) return { status: 'unauthenticated' };

        builtCookieHeader = forwards.join('; ');
        cacheHashSource = matchedTokens.join(' ');
    } else {
        // Byte-identical to today's order: name -> extract -> unauthenticated -> gate -> build.
        const cookieName = resolveEffectiveSessionCookieName(brand);
        if (!cookieName) {
            logger.error({ slug }, '[auth] partner-whoami brand missing sessionCookieName');
            return { status: 'misconfigured', reason: 'missing sessionCookieName' };
        }
        const cookieValue = extractCookieValue(cookieHeader, cookieName);
        if (cookieValue === null) return { status: 'unauthenticated' };

        const target = resolveValidatedWhoamiTarget(brand);
        if (!target.ok) {
            logger.error({ slug, reason: target.reason }, '[auth] whoami target misconfigured');
            return { status: 'misconfigured', reason: target.reason };
        }
        whoamiUrl = target.whoamiUrl;

        const built = buildCookieHeader(target.sessionCookieName ?? cookieName, cookieValue);
        if (built === null) return { status: 'unauthenticated' };

        builtCookieHeader = built;
        cacheHashSource = cookieValue;
    }
```

Then replace the rest of the function's uses of `forwardedCookie` with `builtCookieHeader`, `cacheKeyFor(slug, cookieValue)` with `cacheKeyFor(slug, cacheHashSource)`, and `target.whoamiUrl` at the `fetch` call with `whoamiUrl`.

`extractCookieValue` and `resolveEffectiveSessionCookieName` both stay in the file and stay imported — the partner branch is the caller. `tsconfig.json` sets `noUnusedLocals: true`, so an import left behind by a deleted call site fails the typecheck; the same rule means you must not pre-emptively delete these two.

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/modules/auth/session-resolver.test.ts`
Expected: PASS — the new abe block, and every pre-existing edo test unchanged.

- [ ] **Step 5: Run the whole auth and brand surface**

Run: `pnpm test src/modules/auth src/modules/brand`
Expected: PASS.

- [ ] **Step 6: Run the integration tests**

Run: `pnpm test src/modules/companion/api.routes.integration.test.ts`
Expected: PASS — this confirms **edo is unaffected**, which is the point. Every `makeBrand` call in that file uses `slug: 'edo'`; it constructs no capsule-kind brand, so it does not exercise the abe path at all and cannot prove anything about the six verifier states.

The actual proof that those states do not leak past `resolveSession` is the `describe('resolveSession — abe (kind: capsule)')` block from Step 1: it asserts only on `SessionResolution` values, and `auth.middleware.ts` was never touched.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm lint
git add src/modules/auth/
git commit -m "feat(auth): abe verifies session_data locally before falling back to whoami

Ports node-socket's resolvePartnerSocketIdentity branch. A local failure never
touches the breaker; credential-mismatch forwards the credential alone."
```

---

## Task 8: Record the numbers and update the architecture docs

**Files:**
- Modify: `docs/contracts/abe-session-auth.md` (sections 3.3 and 7)
- Modify: `CLAUDE.md` (the `session-resolver.ts` bullet)
- Modify: `.env.example` (the abe override example)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 2-7.
- Produces: documentation only.

- [ ] **Step 1: Fix the stale abe override example**

`.env.example:103` still shows `"sessionCookieName":"abes_session"`. Replace that line with:

```
# ABE_BRAND_OVERRIDE={"auth":{"whoamiUrl":"https://www.abeduls.com/api/user","signInUrl":"https://designer.abeduls.com/login","authIssuer":"https://auth.abeduls.local"}}
```

`sessionCookieName` is gone for abe — the names are derived from `authIssuer`'s protocol. `authAllowedHosts` is code-only and cannot appear in an override.

- [ ] **Step 2: Confirm the revocation window against what shipped**

Section 3.3 of the contract states `300 s + 45 s ≈ 5 min 45 s`. Verify `CACHE_TTL_SECONDS` in `session-resolver.ts` is still 45. If Task 2 or 7 changed it, correct the sum. The number is the point; a stale sum is worse than none.

- [ ] **Step 3: Tick off the checklist**

Section 7 of the contract is a 9-item implementation checklist. Mark each item done with the task that did it, and leave item 9 (log verification) explicitly open — it cannot be closed from a test run.

- [ ] **Step 4: Update the architecture bullet**

`CLAUDE.md`'s `session-resolver.ts` bullet describes the old single-path flow and names `abes_session` implicitly through "extract the named cookie's value". Rewrite it to describe the two-branch shape, keeping the existing "**Order is a security property**" framing and the reference to abeduls3's `resolvePartnerSocketIdentity.ts`. Add the two Task 2 changes (the 401/403-vs-rest split, cache before breaker) since they are now part of the documented order.

Add one line telling agents to leave `src/vendor/` alone, pointing at `VENDORED.md`. The hash test enforces it; the note stops someone wasting an hour before the test tells them.

- [ ] **Step 5: Fix the abe-is-not-servable contradiction**

`CLAUDE.md:70`, `:107` and `:122` all say abe is not servable, while `registry.ts:65` gives it non-empty `companionHosts`. Three copies of the same stale claim against one contradicting fact; an implementer reading them cannot tell which is true. Resolve it against what Task 1 Step 2 observed in production and correct the losing side — all three lines, not just the two the earlier draft of this plan named.

- [ ] **Step 6: Record the known consequence of verifying locally**

The contract's section 6 now carries a "Known consequence" subsection: a locally verified user never reaches capsule's `/api/user`, which is where `resolveMirrorUser` creates their mirror row, and capsule's media-ingest inserts `uploads` behind a foreign key with a `23503` handler. Confirm that subsection is present and accurate before closing this task.

This is the one cost of choosing local verification over relay-only. It was accepted deliberately; it must be findable by whoever debugs a failed ingest for a user whose uploads used to work.

- [ ] **Step 7: Commit**

```bash
git add docs/contracts/abe-session-auth.md CLAUDE.md .env.example
git commit -m "docs: record the abe two-cookie flow and the revocation window"
```

- [ ] **Step 8: Full local gate**

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Expected: all four green. This mirrors CI's order exactly (`.github/workflows/ci.yml`).

- [ ] **Step 9: The verification a test cannot do**

Deploy to staging and read the logs, per contract §7 item 9 and §3.4:

1. Two uploads by the same abe user inside 45 s produce **zero** abe whoami requests.
2. One upload past the window produces **exactly one**.
3. An edo upload still resolves exactly as before.
4. No `abe local verification unavailable` warning appears in steady state — one means `authIssuer` does not match the auth-service's `BETTER_AUTH_URL` byte for byte, which fails silently by falling back to a round trip per request.

A code review cannot establish any of these. Do not mark this plan complete without them.

---

## Task 9: Close the loop upstream, in the abeduls3 repo

**Files (all in `C:\Users\manue\Documents\projects\abeduls3-clone`):**
- Modify: `packages/auth-verify/README.md` (the "Current and planned consumers" table)
- Modify: `.github/workflows/ci.yml` (one guard step)

**Interfaces:**
- Consumes: the vendored copy from Task 6 existing, and its synced commit SHA.
- Produces: nothing consumed by other tasks. This closes the only drift direction Companion cannot detect on its own.

**Why this task exists.** Task 6's hash manifest catches *local tampering* — someone editing the copy here. It cannot catch *upstream moving on*, because Companion has no access to abeduls3 at test time. That direction has to be detected at the source, and it is ~10 lines.

Note the upstream README already prescribes vendoring as option 1 for out-of-repo consumers ("the existing precedent in this ecosystem"), so this task extends an existing section rather than introducing a policy.

- [ ] **Step 1: Add Companion to the consumers table**

`packages/auth-verify/README.md`, the "Current and planned consumers" table. Add a column recording the synced commit, and a row:

```markdown
| Service | Uses this package | Synced at | What it does today |
|---|---|---|---|
| ... existing rows, with `—` in the new column ... |
| Companion (`uppy-companion-multi-brand`, external repo) | **Vendored copy** of `src/` | `<full 40-char SHA>` | `src/vendor/auth-verify/`, wrapped by `src/modules/auth/abe-session-verifier.ts`. Verifies abe locally, falls back to capsule's whoami on any non-`valid` status. See its `src/vendor/auth-verify/VENDORED.md` |
```

The SHA must equal the one in Companion's `VENDORED.md`. These two files are the whole sync ledger; if they disagree, neither is trustworthy.

- [ ] **Step 2: Add the CI guard**

`.github/workflows/ci.yml` — note it already checks out with `fetch-depth: 2`, which is enough for a two-dot diff against the base. Add this step after "Install dependencies":

```yaml
      # Vendored copies exist outside this repo and cannot notice an upstream change.
      # Touching the sync table is the signal to the human who syncs them.
      - name: Vendored consumers are still in sync
        if: github.event_name == 'pull_request'
        run: |
          base="origin/${{ github.base_ref }}"
          git fetch --no-tags --depth=1 origin "${{ github.base_ref }}"
          changed=$(git diff --name-only "$base"...HEAD)
          if echo "$changed" | grep -q '^packages/auth-verify/src/' \
             && ! echo "$changed" | grep -q '^packages/auth-verify/README.md$'; then
            echo "::error::auth-verify/src changed but the vendored-consumers table in"
            echo "::error::packages/auth-verify/README.md was not updated. Re-sync the copies"
            echo "::error::(see the table) or record why this change does not need a re-sync."
            exit 1
          fi
```

The guard is deliberately dumb: it cannot tell a formatting change from a wire-behaviour change, and it should not try. Its job is to put a human in the loop exactly once per change to that directory.

- [ ] **Step 3: Prove it fires and prove it clears**

Open a throwaway PR that adds a blank line to `packages/auth-verify/src/index.ts`.
Expected: CI **fails** on this step.

Push a second commit touching `packages/auth-verify/README.md`.
Expected: CI **passes**. Close the PR without merging.

A guard nobody has watched fail is a guard nobody can trust — the same reason Task 6 Step 7 asks you to break the hash on purpose.

- [ ] **Step 4: Note the real drift trigger**

Add one line under the consumers table:

```markdown
The change most likely to matter to a vendored copy is a `better-auth` bump in `auth-service`:
it can move the session-cookie wire format. `tests/betterAuthConformance.test.ts` diffs this
package against `better-auth/cookies`' own `getCookieCache`, so such a change fails here first,
forces an `src/` edit, and trips the sync guard above.
```

That sentence is the reason the whole chain works, and it is not obvious from any single file.

- [ ] **Step 5: Commit**

```bash
git add packages/auth-verify/README.md .github/workflows/ci.yml
git commit -m "ci(auth-verify): changes to src must touch the vendored-consumers table

Companion carries a byte-identical copy and cannot detect an upstream change
from its own test suite.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Post-plan: what this deliberately does not do

- **No sensitive-route cache bypass** (D6). Uploads change nothing privileged; the ~5 min 45 s revocation window is accepted and recorded.
- **No change to `picaboo`.** It stays a `partner-whoami` brand with an empty `whoamiUrl`. An authenticated request still resolves `misconfigured`; an anonymous one still resolves `unauthenticated`, which is why Task 7 keeps the SSRF gate below the credential check rather than hoisting it.
- **No token-exchange model.** Cookie relay is correct for first-party services under one SSO domain (contract §3.5); a minted scoped token is the end state only for a genuinely external destination, and nothing here is one.
- **No published package, and no `jwksOrigin`** — both evaluated and cut, with the reasons in D3 and D4 so they are not re-proposed.
- **No conformance vectors.** They only detect drift in a *reimplementation*, and a byte-identical copy cannot drift semantically without diverging bytes — which the hash manifest already catches for ~15 lines. The trigger to build them is the first Python service that verifies locally rather than relaying to capsule `/api/user`; until then they would guard nothing.

## The road not taken, and what would put us back on it

This plan builds local JWKS verification. A smaller alternative was considered seriously and rejected by the user: correct the cookie names and forward both cookies to the existing whoami, with no verifier at all. That is roughly Tasks 1, 3, 4, 5, 7 and 8 without the verifier branch, it fixes the same outage, and it is safe because capsule's `getBetterSession` already performs the credential binding and bypasses the cookie cache on a mismatch.

It was rejected deliberately. Recording it here because two facts make the trade real, and whoever maintains this should know them:

- The win from local verification is capped by the existing 45 s Redis cache at one whoami call per user per 45 s — not one per request.
- Every upload calls capsule's ingest endpoint anyway, so capsule availability is on the critical path whether or not auth goes through it.

If the verifier ever becomes a maintenance burden, deleting the Task 6/7 branch and falling back to relay-only is a contained change, not a rewrite. That is the escape hatch this design deliberately preserves.
