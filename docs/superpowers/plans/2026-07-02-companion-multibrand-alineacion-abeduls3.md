# Rediseño Companion multi-brand + alineación abeduls3 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Estado: revisado por Fable 5 + Sonnet 5 (ronda 1 aplicada). Deriva de la spec `docs/superpowers/specs/2026-07-02-companion-multibrand-alineacion-abeduls3-design.md`.

**Goal:** Rediseñar `companion-platform-multi-brand` para hablar el mismo modelo de marca y autenticación que abeduls3 (`@package/brands`) y endurecerlo para producción (Redis, observabilidad, SSRF, secretos, CI), empezando por la marca **edo** (abe justo después).

**Architecture:** Instancias `@uppy/companion` aisladas por marca, resueltas por `Host` (exact-match contra `companionHosts`). Contrato reimplementado 1:1 desde `@package/brands` (registro base + `<SLUG>_BRAND_OVERRIDE`). Auth por reenvío de cookie al `whoamiUrl` del partner con SSRF gate + circuit breaker (Redis) + caché Redis (patrón `resolvePartnerSocketIdentity` + `enrichEdoUser`). Estado compartido en Redis para ≥2 réplicas.

**Tech Stack (versiones fijadas — Node 22 ESM):** `ioredis@^5`, `connect-redis@^8` (API `new RedisStore({client})`), `rate-limit-redis@^4` + `express-rate-limit@^7`, `pino@^9` + `pino-http@^10`, `helmet@^8`, `@biomejs/biome@^2`, `@aws-sdk/client-secrets-manager@^3` (alineado con `@aws-sdk/client-s3@^3.975`). Dev: `ioredis-mock@^8`. Tests: Vitest + supertest + `aws-sdk-client-mock`.

## Global Constraints

- Node **>= 22**; pnpm. ESM NodeNext: **imports internos con sufijo `.js`**. TS **strict** + `noUnused*`. No `any` nuevos sin justificación.
- `pnpm build` usa **`tsconfig.build.json`** (nunca la raíz).
- Proyecto **no en producción**: se eliminan campos legacy sin capa de compatibilidad.
- Slugs válidos: **`abe`**, **`picaboo`**, **`edo`** (Entourage = `edo`).
- **NO overridables** por `<SLUG>_BRAND_OVERRIDE`: `kind`, `whoamiAllowedHosts`, `assets.s3Prefix`, `companionHosts`, `s3`, `providers`. Solo overridables: campos string de `auth` (`whoamiUrl`, `signInUrl`, `signOutUrl`, `sessionCookieName`).
- Secretos S3/OAuth por Secrets Manager, **no** en el override.
- Presigned URLs `expiresIn` **≤ 300 s**.
- whoami: `redirect:'manual'`, timeout **5000 ms**, body cap **16 KB**, caché namespace **`companion-whoami:{slug}:{sha256(cookie)}`** TTL **45 s fijo** guardando el **`BrandUser` completo**, breaker **3 fallos → open `EX 30`** con half-open. **Orden: `breaker.isOpen` ANTES de la caché.**
- Identidad S3 = **`user.id` canónico para TODAS las marcas** (401 si falta; **NO se usa `edoId`** para keys — SA1). edo replica el esquema real de edonext `original/{id}/{yyyy}/{mm}/{dd}/{ts}/UPID_{orderId}/{file}` en bucket `entourage-uploads`. Aislamiento por **bucket** por marca (no por prefijo `brands/{slug}/`). `UPID_{orderId}` a confirmar con edo (smoke test).
- TDD: test que falla → impl mínima → test pasa → commit. Rama por fase, **nunca commit directo a `main`**; **cada fase deja `typecheck` verde** (el cutover del contrato es atómico, ver Fase 2). PR por fase.

---

## Estructura de ficheros (destino)

**Nuevos:** `src/lib/logger.ts`, `src/lib/redis.ts`, `src/lib/secrets.ts`, `src/modules/brand/slugs.ts`, `src/modules/brand/registry.ts`, `src/modules/brand/identity.ts`, `src/modules/brand/detect.ts`, `src/modules/brand/brand.contract.ts` (nuevos tipos, coexiste hasta el cutover), `src/modules/auth/session-resolver.ts`, `src/modules/auth/enrich-edo.ts`, `src/modules/auth/whoami-breaker.ts`, `docs/adr/ADR-001-tenancy-pool-bridge.md`.

**Reescritos en el cutover atómico (Task 2.7):** `src/modules/brand/brand.types.ts` (→ re-export de `brand.contract.ts`), `brand.schema.ts`, `brand.service.ts`, `src/server.ts`, `src/modules/companion/companion.factory.ts`, `src/modules/companion/uppy.routes.ts`, `src/modules/companion/s3/s3.key-builder.ts`, `src/modules/companion/s3/s3.controller.ts`, `src/modules/folders/folders.service.ts`, `src/modules/auth/auth.middleware.ts`, `src/test-utils/fixtures.ts`, `src/test-utils/http.ts`, `src/config/env.ts`, `src/config/env.schema.ts`. **Eliminados:** `src/modules/auth/auth.service.ts`; código muerto de `s3Client.ts`; ficheros sueltos de raíz.

---

## Estimación (equipo 1-3 devs)

| Fase | Contenido | Esfuerzo (1 dev) |
|---|---|---|
| 0 | Higiene/CI (quick wins) | ~1 día |
| 1 | Observabilidad + Redis | ~2-3 días |
| 2 | Modelo de marca + cutover | ~4-5 días |
| 3 | Auth endurecida | ~2-3 días |
| 4 | S3 keys/límites/SSRF | ~2 días |
| 5 | Ensamblaje (Host, sesión, rate-limit, uppy.routes, fixtures) | ~3-4 días |
| 6 | Secrets Manager | ~1-2 días |
| 7 | Docs + smoke test stage | ~1-2 días |
| **MVP edo** | Fases 0–7 | **~3 semanas (1 dev) / ~1.5 sem (2-3)** |

---

## FASE 0 — Higiene y desbloqueo (quick wins)  ·  ~1 día  ·  PR independiente

### Task 0.0: ADR-001 de tenancy (antes del código de resolución por Host)
**Files:** Create: `docs/adr/ADR-001-tenancy-pool-bridge.md`
- [ ] **Step 1:** Redactar el ADR (spec D12): pool por defecto (resolución por Host exact-match), aislamiento reforzado (Redis, Secrets Manager, STS en Fase 8), puerta a bridge/silo vía `BRAND_FORCE`, criterios de activación (volumen/compliance).
- [ ] **Step 2:** Commit `docs(adr): ADR-001 modelo de tenancy pool + bridge`.

### Task 0.1: Arreglar `.dockerignore` (build roto)
**Files:** Modify: `.dockerignore`
- [ ] **Step 1:** Reproducir: `docker build -t companion-test .` → falla / no genera `dist/modules/companion/uppyModal.js` (el Dockerfile corre `node scripts/build-assets.mjs` pero `.dockerignore:12` excluye `scripts`).
- [ ] **Step 2:** Eliminar las líneas `scripts` y `test` de `.dockerignore`.
- [ ] **Step 3:** `docker build -t companion-test .` → PASS; contiene el bundle.
- [ ] **Step 4:** Commit `fix: no excluir scripts/ del contexto Docker`.

### Task 0.2: `pnpm build` gate en CI
**Files:** Modify: `.github/workflows/ci.yml`
- [ ] **Step 1:** Añadir `- run: pnpm build` tras `typecheck`.
- [ ] **Step 2:** `pnpm build` local → PASS. **Step 3:** Commit `ci: pnpm build como gate`.

### Task 0.3: Biome (ruleset acotado) + gate CI
**Files:** Create: `biome.json`; Modify: `package.json`, `.github/workflows/ci.yml`
- [ ] **Step 1:** `pnpm add -D @biomejs/biome@^2 && pnpm biome init`.
- [ ] **Step 2:** En `biome.json` empezar con un ruleset **acotado** (formatter on; linter con `recommended` pero desactivando reglas ruidosas que hoy fallen en masa; subir el rigor luego). Scripts `lint`/`format` en `package.json`.
- [ ] **Step 3:** `pnpm format` y `pnpm lint` → sin errores.
- [ ] **Step 4:** CI: `- run: pnpm lint` antes de `typecheck`. **Step 5:** Commit `ci: Biome (lint+format) con ruleset inicial acotado`.

### Task 0.4: Dependabot + CodeQL + gitleaks
**Files:** Create: `.github/dependabot.yml`, `.github/workflows/codeql.yml`, `.github/workflows/gitleaks.yml`
- [ ] **Step 1-3:** Dependabot (npm semanal), CodeQL (`javascript-typescript`), gitleaks (push/PR). **Step 4:** Commit `ci: Dependabot + CodeQL + gitleaks`.

### Task 0.5a: `USER node` en Dockerfile
**Files:** Modify: `Dockerfile`
- [ ] **Step 1:** `USER node` en el stage `runner` (ajustar `chown` de `/app`). **Step 2:** `docker build` → PASS. **Step 3:** Commit `hardening: correr contenedor como usuario node`.

### Task 0.5b: Borrar código muerto de `s3Client.ts`
**Files:** Modify: `src/lib/aws/s3Client.ts`
- [ ] **Step 1:** `grep -rn "uploadFile\|downloadFileAsBuffer\|generateSignedUrl" src --include=*.ts` → solo definiciones. **Step 2:** Borrar las 3 funciones (conservar `getS3Client`). **Step 3:** `pnpm typecheck && pnpm test` → PASS. **Step 4:** Commit `chore: eliminar código muerto de s3Client`.

### Task 0.5c: Limpiar ficheros sueltos de la raíz
**Files:** Delete/Move: `REAME.GOOGLE.CONFIG.MD`, `metadata-delete.json`, `uppy-test.html`, `companion-server.code-workspace`, `readme.arquitecture.png`
- [ ] **Step 1:** Mover a `docs/legacy/` o borrar. **Step 2:** Commit `chore: limpiar ficheros sueltos de la raíz`.

---

## FASE 1 — Observabilidad y Redis  ·  ~2-3 días

### Task 1.1: Logger Pino + AsyncLocalStorage
**Files:** Create: `src/lib/logger.ts`, `logger.test.ts` · **Produces:** `logger`, `runWithContext(ctx,fn)`, `getContext()`, `setUserId(id)`, `httpLogger`.
- [ ] **Step 1: Test** (contexto dentro/fuera de `runWithContext`) — ver bloque:
```ts
import { describe, it, expect } from 'vitest';
import { runWithContext, getContext } from './logger.js';
describe('log context', () => {
  it('propaga', () => runWithContext({requestId:'r1',brand:'edo'}, () => {
    expect(getContext()?.requestId).toBe('r1'); expect(getContext()?.brand).toBe('edo'); }));
  it('vacío fuera', () => expect(getContext()).toBeUndefined());
});
```
- [ ] **Step 2:** `pnpm test src/lib/logger.test.ts` → FAIL.
- [ ] **Step 3:** Implementar con `AsyncLocalStorage` + `pino` + `pino-http` (mixin inyecta el contexto; `genReqId` usa `x-request-id` o `crypto.randomUUID()`). `pnpm add pino@^9 pino-http@^10`.
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(logger): Pino + AsyncLocalStorage`.

### Task 1.2: Cliente Redis compartido
**Files:** Create: `src/lib/redis.ts`, `redis.test.ts` · **Produces:** `getRedis()`, `closeRedis()`.
- [ ] **Step 1: Test** (mock `ioredis`→`ioredis-mock`): singleton + set/get.
- [ ] **Step 2:** FAIL. **Step 3:** `pnpm add ioredis@^5 && pnpm add -D ioredis-mock@^8`; implementar singleton (`new Redis(env.redisUrl,{maxRetriesPerRequest:2})`). **Step 4:** PASS. **Step 5:** Commit `feat(redis): cliente ioredis compartido`.

### Task 1.3: Readiness + graceful shutdown
**Files:** Modify: `src/server.ts`, `src/index.ts`; Test: `server.integration.test.ts`
- [ ] **Step 1: Test:** `GET /api/readyz` → 200 con Redis `PING` ok **y** S3 alcanzable; → 503 con flag `shuttingDown`; **→ 503 cuando el chequeo S3 falla/expira** (mock `HeadBucketCommand` rechazando). `/api/healthz` sigue liveness.
- [ ] **Step 2:** FAIL. **Step 3:** `/api/readyz` en `assembleApp`: `getRedis().ping()` (timeout 1s) **+ `HeadBucketCommand` sobre el bucket de una marca servible con timeout corto (~1-2s)** (alineado con spec D10) + flag `shuttingDown`; en `index.ts` SIGTERM → `shuttingDown=true`, `server.close()`, `setTimeout(()=>process.exit(0),10_000).unref()`, cerrar WS Companion + `closeRedis()`. **Step 4:** PASS. **Step 5:** Commit `feat(ops): readiness (Redis+S3) + graceful shutdown`.

### Task 1.4: httpLogger + reemplazar console.*
**Files:** Modify: `src/server.ts`, `src/index.ts`, módulos con `console.*`
- [ ] **Step 1:** Montar `httpLogger` (envuelto en `runWithContext`) como primer middleware. **Step 2:** Reemplazar cada `console.*` por `logger`. `grep -rn "console\." src --include=*.ts | grep -v test` → vacío. **Step 3:** `pnpm typecheck && pnpm test` → PASS. **Step 4:** Commit `refactor(log): sustituir console.* por logger`.

---

## FASE 2 — Modelo de marca (cutover atómico al final)  ·  ~4-5 días

> **Estrategia anti-typecheck-roto:** Tasks 2.1–2.6 crean módulos nuevos que usan `brand.contract.ts` (coexiste con el viejo `brand.types.ts`); nada viejo cambia → `typecheck` verde en cada commit. **Task 2.7 es el cutover atómico**: reemplaza el tipo global y arregla TODOS los consumidores en un commit que deja `typecheck` verde.

### Task 2.1: Slugs
**Files:** Create: `src/modules/brand/slugs.ts`, `slugs.test.ts` · **Produces:** `BRAND_SLUGS`, `BRAND_SLUG_VALUES`, `BrandSlug`, `isBrandSlug`.
- [ ] Test (`isBrandSlug('edo')` true, `'nope'` false) → FAIL → implementar (copia 1:1 de `packages/brands/src/slugs.ts`) → PASS → commit.

### Task 2.2: Contrato `brand.contract.ts` (tipos nuevos, coexiste)
**Files:** Create: `src/modules/brand/brand.contract.ts` · **Produces:** `BrandAuthConfig` (union), `BrandResponseMapping`, `EdoUploadPlugin`, `CompanionBrandConfig` (con `companionHosts`, `assets.s3Prefix`, `upload`, **`limits: { maxUploadBytes: number; allowedContentTypes?: readonly string[] }`**, `public?.foldersUrl`), `Brand` (resuelto, `s3.client`), `BrandRegistry`, `BrandUser` (con `edoId?:number`).
- [ ] **Step 1:** Escribir `brand.contract.ts` con el shape de spec §4-D2. **NO** tocar `brand.types.ts` todavía.
- [ ] **Step 2:** `pnpm typecheck` → PASS (fichero nuevo, sin consumidores). **Step 3:** Commit `feat(brand): contrato CompanionBrandConfig (coexiste)`.

### Task 2.3: Registro base
**Files:** Create: `src/modules/brand/registry.ts`, `registry.test.ts` · **Consumes:** `brand.contract.ts`. **Produces:** `getBaseBrandConfig(slug)`, `getServableSlugs()` (deep-frozen).
- [ ] Test (`edo`: `kind==='partner-whoami'`, `whoamiAllowedHosts:['entourageyearbooks.com']`, `s3.bucket==='entourage-uploads'`, `assets.s3Prefix===''` (SA1: edo usa `original/{id}/` directo), **`companionHosts` incluye prod Y stage** (`companion.entourageyearbooks.com` + `companion.stage.entourageyearbooks.com`), `Object.isFrozen`; `getServableSlugs()` devuelve `['edo']`) → FAIL → implementar `deepFreeze` + registro `edo` completo (spec §5, `companionHosts` con prod+stage porque es code-only, no overridable) + **`abe` y `picaboo` como NO-servables** (`companionHosts: []` — array vacío, no ausente, para cumplir el tipo; hasta confirmar sus endpoints — abe depende de D5.b/SA, picaboo aún sin datos; **no inventar un `whoamiUrl` de capsule**); `getServableSlugs` filtra los de `companionHosts.length===0` → PASS → commit.

### Task 2.4: Identity — override merge
**Files:** Create: `src/modules/brand/identity.ts`, `identity.test.ts` · **Produces:** `readBrandOverride(slug)`, `resolveEffectiveAuth(cfg)`, `resolveEffectiveSessionCookieName(cfg)`, `resolveValidatedWhoamiTarget(cfg)`, `buildCookieHeader(name,value)`, `normalizeBrandUser(mapping,raw)`.
- [ ] **Step 1: Test** (portar `packages/brands/tests/identity.test.ts`): JSON malformado→base; `__proto__` ignorado; override de `kind`/`whoamiAllowedHosts`/`assets`/`companionHosts` ignorado; `sessionCookieName`>128→base; `whoamiUrl` fuera de allowlist→`{ok:false}`; `buildCookieHeader` rechaza `;`/CRLF→null; `normalizeBrandUser` valida `id`/`email`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar copiando `packages/brands/src/identity.ts` (`${slug.toUpperCase().replace(/-/g,'_')}_BRAND_OVERRIDE`, `PROTO_KEYS`, `PROTECTED_AUTH_KEYS={kind,whoamiAllowedHosts}`, validación por campo, revalidación de host, anti-inyección) **+ log Pino en cada rechazo**. `assets`/`companionHosts` no forman parte del merge (code-only). **GENERALIZAR `resolveValidatedWhoamiTarget`:** a diferencia del original (que devuelve `{ok:false}` si `kind!=='partner-whoami'`, `identity.ts:152-159`), debe validar el `whoamiUrl`+`whoamiAllowedHosts` **también para `capsule`** (ambas variantes los llevan en el contrato Companion) — si no, abe nunca haría fetch. Test: `resolveValidatedWhoamiTarget(capsuleBrand).ok === true`. **Step 4:** PASS. **Step 5:** Commit `feat(brand): override con allowlist + SSRF gate (partner+capsule) + log`.

### Task 2.5: Detect — resolución por Host (exact-match)
**Files:** Create: `src/modules/brand/detect.ts`, `detect.test.ts` · **Produces:** `resolveBrandByHost(host?)` (respeta `BRAND_FORCE`).
- [ ] **Step 1: Test:** `BRAND_FORCE=edo`→siempre `edo`; sin force, `Host:'companion.stage.entourageyearbooks.com'` (∈ `companionHosts`)→`edo`; **`Host:'designer.stage.entourageyearbooks.com'` (subdominio distinto, NO en `companionHosts`)→`null`** (el matching de marca es exact-match contra `companionHosts`, no sufijo); host desconocido en prod→`null`; en dev→default configurable. **Usar hosts `companion.*` (del Companion), no `linkdesigner.*`.**
- [ ] **Step 2:** FAIL. **Step 3:** Implementar **exact-match** del host normalizado contra `companionHosts` (patrón `detect.ts:16-23` de abeduls3, `.includes(normalized)`), `BRAND_FORCE` gana, **404/null en host desconocido en prod (NO default a abe)**. **Step 4:** PASS. **Step 5:** Commit `feat(brand): resolveBrandByHost exact-match + BRAND_FORCE`.

### Task 2.6: Schema Zod + brand.service en ficheros `.next.ts` (coexisten, no rompen typecheck)
**Files:** Create: `src/modules/brand/brand.schema.next.ts`, `src/modules/brand/brand.service.next.ts` · **Produces:** `createBrandRegistry()`, `resolveBrand(...)`.
> ⚠️ **No reescribir `brand.schema.ts`/`brand.service.ts` aquí:** hoy los importa `src/config/env.ts:1-3` con el modelo legacy; reescribirlos rompería `typecheck` **antes** del cutover. Se crean como `.next.ts` y el cutover atómico (Task 2.7) los renombra sobre los viejos.
- [ ] **Step 1: Test:** el registro base + `EDO_BRAND_OVERRIDE` de ejemplo parsea; `createBrandRegistry` produce `Brand` con `s3.client`. Secrets vía fallback env (stub, se completa en Fase 6).
- [ ] **Step 2:** `pnpm test` → FAIL; `pnpm typecheck` → sigue **verde** (ficheros nuevos, nadie los importa aún). **Step 3:** Implementar Zod de la union + `createBrand`/`createBrandRegistry` en los `.next.ts` (registro base → override → S3/OAuth desde stub-secrets/env → `Brand`). **Step 4:** test PASS, typecheck verde. **Step 5:** Commit `feat(brand): schema + service (.next) sobre contrato nuevo`.

### Task 2.7: **Cutover atómico** (reemplazar tipo global + todos los consumidores)
**Files:** Rewrite: `brand.types.ts` (→ `export * from './brand.contract.js'`), `server.ts`, `companion.factory.ts`, `uppy.routes.ts`, `s3/s3.controller.ts`, `s3/s3.key-builder.ts`, `folders.service.ts`, `auth.middleware.ts`, `test-utils/fixtures.ts`, `test-utils/http.ts`, `config/env.ts`; Delete: `auth.service.ts`.
- [ ] **Step 1:** Renombrar `brand.schema.next.ts`→`brand.schema.ts` y `brand.service.next.ts`→`brand.service.ts` (reemplazando los viejos de Task 2.6); reapuntar `brand.types.ts` al contrato nuevo; ajustar cada consumidor a los nuevos nombres (`auth.whoamiUrl`/`signInUrl`/`sessionCookieName`, `assets.s3Prefix`, `upload.plugins`, `companionHosts`), **eliminando los campos legacy**. (Auth y key-builder se sustituyen a fondo en Fases 3-4; aquí sólo se hace que compilen contra el contrato, dejando un **shim de auth fail-closed explícito** — SIN campos legacy.) **Especificación del shim interino (2.7 → 3.3):** `attachUser` = no-op (no puebla `req.user`); `requireAuth` = **responde 401 siempre** (fail-closed) hasta que la Fase 3 lo cablee con `resolveSession`. El shim NUNCA debe dejar pasar sin auth; un test de `server.integration` verifica que `/api/uppy/*` da 401 en este estado interino. Reescribir `fixtures.makeBrand`/`http.createTestApp` al nuevo `Brand`/`assembleApp`.
- [ ] **Step 2:** `pnpm typecheck` → **PASS** (árbol verde). `pnpm test` → PASS (tests viejos adaptados o marcados para reescritura en fases siguientes).
- [ ] **Step 3:** Commit `refactor(brand)!: cutover al contrato abeduls3; eliminar modelo legacy`.

---

## FASE 3 — Autenticación endurecida  ·  ~2-3 días

### Task 3.1: Circuit breaker por marca (Redis, half-open)
**Files:** Create: `src/modules/auth/whoami-breaker.ts`, `whoami-breaker.test.ts` · **Produces:** `recordSuccess(slug)`, `recordFailure(slug)`, `isOpen(slug)`, `tryHalfOpen(slug)`.
- [ ] **Step 1: Test:** 3 `recordFailure` (con `INCR` atómico) → `isOpen` true; `recordSuccess` borra el contador y cierra; al expirar `EX 30`, `tryHalfOpen` permite **una** sonda; test de concurrencia (dos réplicas simuladas no ambas sondan).
- [ ] **Step 2:** FAIL. **Step 3:** Implementar con `whoami:breaker:{slug}` (`INCR`), `:open` (`SET EX 30`), y una key de sonda half-open (`SET NX EX`). Documentar la degradación vs breaker in-memory de node-socket.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(auth): breaker por marca Redis con half-open`.

### Task 3.2: Session resolver (whoami + enrichEdo + caché full-user)
**Files:** Create: `src/modules/auth/session-resolver.ts`, `enrich-edo.ts`, tests · **Produces:** `resolveSession(brand, cookieHeader)` → `{status:'authenticated',user:BrandUser}|{'unauthenticated'}|{'unavailable',reason}|{'misconfigured',reason}`.
- [ ] **Step 1: Test** (mock `fetch`): `200`+`{id:'1004',edo_id:854569,email,name}` → `authenticated` **con `user.edoId===854569`** (enrichEdo) y cachea el user completo; segunda llamada = **cache hit** (no vuelve a fetch) y **conserva `edoId`**; `401`→`unauthenticated`+`recordSuccess`; `503`/`3xx`/`status 0`/`4xx≠401`→`unavailable`+`recordFailure`; body>16KB→`unavailable`; timeout→`unavailable`; **breaker abierto → `unavailable` sin fetch ni caché** (orden breaker-first).
```ts
it('200 enriquece edoId y cachea el user completo', async () => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({id:'1004', edo_id:854569, email:'a@b.com', name:'A'}), {status:200}));
  const r = await resolveSession(edo, 'auth_session=abc');
  expect(r.status).toBe('authenticated');
  expect((r as any).user.edoId).toBe(854569);
  const r2 = await resolveSession(edo, 'auth_session=abc');           // cache hit
  expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  expect((r2 as any).user.edoId).toBe(854569);                        // conservado en hit
});
```
- [ ] **Step 2:** FAIL. **Step 3:** Implementar **en este orden exacto** (propiedad de seguridad, fiel a `resolvePartnerSocketIdentity.ts:44-73`): extraer valor de cookie → `resolveValidatedWhoamiTarget` (`misconfigured` si falla) → **`const h = buildCookieHeader(name,val); if (h===null) return unauthenticated`** (ANTES del breaker: cookie malformada NO abre el breaker) → `breaker.isOpen` (`unavailable`) → caché Redis `companion-whoami:{slug}:{sha256(cookie)}` (TTL 45, `BrandUser` JSON completo, solo `authenticated`) → `fetch({headers:{Cookie:h},redirect:'manual',signal:AbortSignal.timeout(5000)})` → `readBodyCapped(16*1024)` → interpretación de estado → `normalizeBrandUser` → **si `slug==='edo'`** `enrichEdoUser` (portado de `apps/designer/lib/auth/brandResolver.ts`: `readEdoExtras:161-181` + `parseEdoEmail`/`enrichEdoUser:194-199`; lee `raw.edo_id`→`edoId` y normaliza email `<user>::<email>`). Borrar `auth.service.ts`.
  Añadir test: **cookie malformada (`;`/CRLF) → `unauthenticated` y el breaker NO registra fallo** (verifica que `recordFailure` no fue llamado).
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(auth): session-resolver con SSRF gate + breaker + cache full-user + enrichEdo`.

### Task 3.3: Adaptar middleware auth
**Files:** Rewrite: `src/modules/auth/auth.middleware.ts`; Test: `auth.middleware.test.ts`
- [ ] **Step 1: Test:** `attachUser` puebla `req.user` en `authenticated`, `undefined` en `unauthenticated`, y en `unavailable` NO lanza (log warn); `setUserId` al contexto. `requireAuth`: 401 (`unauthenticated`/sin user), **503** (`unavailable`), 403 (`misconfigured`).
- [ ] **Step 2:** FAIL. **Step 3:** Implementar sobre `resolveSession`. **Step 4:** PASS. **Step 5:** Commit.

---

## FASE 4 — S3: keys, límites, SSRF  ·  ~2 días

### Task 4.1: Key-builder con id canónico + esquema de edonext (SA1)
**Files:** Rewrite: `src/modules/companion/s3/s3.key-builder.ts`; Test: `s3.key-builder.test.ts`
- [ ] **Step 1: Test:** edo con `user.id='1004'` + `metadata.orderId='8568744'` → `original/1004/2026/7/2/<ts>/UPID_8568744/<file>` (bucket `entourage-uploads`, sin prefijo `brands/`); **falta `user.id` → throw (→401)**; edo **sin `orderId`** → key sin el segmento `UPID_` (o el comportamiento que confirme edo — ver nota); marca con `assets.s3Prefix` no vacío → prefijo antepuesto; `buildUserKeyPrefix(brand,user)` = `{s3Prefix}original/{id}/`.
```ts
it('edo usa id canónico + UPID (no edoId)', () => {
  const key = buildS3Key({ req: reqWith({ id:'1004', edoId:854569 }, edo), filename:'f.png', metadata:{ orderId:'8568744' } });
  expect(key).toMatch(/^original\/1004\/\d{4}\/\d{1,2}\/\d{1,2}\/\d+\/UPID_8568744\/f\.png$/);
  expect(key).not.toContain('854569');   // el edoId NO aparece en la key
});
it('lanza si falta user.id', () => {
  expect(() => buildS3Key({ req: reqWith({ }, edo), filename:'f.png' })).toThrow();
});
```
- [ ] **Step 2:** FAIL. **Step 3:** Implementar: `const uid = user.id; if (!uid) throw;` (id canónico para TODAS las marcas — **no** ramificar por kind/slug ni usar `edoId`). Prefijo `brand.assets.s3Prefix` (vacío para edo). Esquema `{s3Prefix}original/{uid}/{yyyy}/{mm}/{dd}/{ts}/[UPID_{orderId}/]{filename}` con `orderId` desde `metadata`. **`UPID_{orderId}` a confirmar con edo (SA1, smoke test):** si `orderId` no está presente, omitir el segmento (comportamiento por defecto hasta confirmar si es obligatorio). **Step 4:** PASS. **Step 5:** Commit `feat(s3): keys con id canónico + esquema edonext (SA1)`.

### Task 4.2: Límite de tamaño declarado + sendIfKeyNotOwned
**Files:** Modify: `s3/s3.controller.ts`; Test: `api.routes.integration.test.ts`
- [ ] **Step 1: Test:** `sign-s3`/`signPart` → 400 si `Content-Length` declarado > `brand.limits.maxUploadBytes` (o `Content-Type` fuera de `brand.limits.allowedContentTypes` si está definido); `sendIfKeyNotOwned` → 403 si la key no empieza por `buildUserKeyPrefix`. `expiresIn:300`.
- [ ] **Step 2:** FAIL. **Step 3:** Validar contra `brand.limits.maxUploadBytes`/`allowedContentTypes` (ya definidos en el contrato, Task 2.2). **Nota:** cierra **parcialmente** H13 (declarativo; enforcement server-side real = presigned POST, Fase 8). **Step 4:** PASS. **Step 5:** Commit `feat(s3): límite de tamaño/tipo declarado (H13 parcial); conservar BOLA`.

### Task 4.3: Cerrar SSRF + validHosts (H1/H2/H7)
**Files:** Modify: `companion.factory.ts`; Test: `companion.factory.test.ts`
- [ ] **Step 1: Test:** `env.protocol==='http'`→`allowLocalUrls:true`; `'https'`→`false`. `uploadUrls` derivado (no `['*']`). **`validHosts`/`COMPANION_CLIENT_ORIGINS` presentes y derivados de `companionUrl`/`domains`** (test explícito, cierra H7).
- [ ] **Step 2:** FAIL. **Step 3:** `allowLocalUrls: env.protocol==='http'`; `uploadUrls` derivado; setear `validHosts` y `companionUrl` como fuente del `redirect_uri`; mapear `upload.plugins` tipado → providers. **Step 4:** PASS. **Step 5:** Commit `fix(security): cerrar SSRF + validHosts`.

---

## FASE 5 — Ensamblaje del servidor  ·  ~3-4 días

### Task 5.1: Resolución por Host en `server.ts`
**Files:** Modify: `src/server.ts`; Test: `server.integration.test.ts`
- [ ] **Step 1: Test:** `Host:'companion.stage.entourageyearbooks.com'` (o `BRAND_FORCE=edo`) enruta a la instancia companion de `edo`; host desconocido en prod → 404; sin segmento `/default/`.
- [ ] **Step 2:** FAIL. **Step 3:** Middleware `resolveBrandByHost(req.headers.host)`→`req.brand`→instancia companion (mapa slug→instancia); `companionUrl` base OAuth. **Step 4:** PASS. **Step 5:** Commit `feat(server): resolución por Host`.

### Task 5.2: express-session Redis + rate-limit + helmet (cookie path/name)
**Files:** Modify: `src/server.ts`; Test: `server.integration.test.ts`
- [ ] **Step 1: Test:** el `store` de sesión es `RedisStore` (no MemoryStore); `cookie.path==='/'` y **`name==='companion.sid'` (único/estático, NO por-slug** — configuración única, `brand` no está en scope; aislamiento por host lo da el `companionHost`); `/api/*` y `/uppy` → 429 al exceder el límite; respuestas con CSP de helmet **que incluye `script-src ... 'nonce-<valor>'`** y el mismo nonce aparece en el `<script>` inline de `/uppy` (ver Task 5.4).
- [ ] **Step 2:** FAIL. **Step 3:** `pnpm add connect-redis@^8 express-rate-limit@^7 rate-limit-redis@^4 helmet@^8`. Wiring exacto (`express-session` se monta **una sola vez** en `assembleApp`, con `name` estático):
```ts
import { RedisStore as SessionStore } from 'connect-redis';
import { RedisStore as RateStore } from 'rate-limit-redis';
session({ store: new SessionStore({ client: getRedis(), prefix: 'companion:sess:' }),
          name: 'companion.sid', cookie: { path: '/', secure: isHttps, sameSite: isHttps?'none':'lax', httpOnly:true }, /* … */ });
rateLimit({ store: new RateStore({ sendCommand: (...args: string[]) => getRedis().call(...args) }),
            keyGenerator: (req) => `${req.brand?.slug}:${req.user?.id ?? req.ip}`, /* windowMs, limit */ });
// CSP con NONCE por request (uppy.html tiene un <script type="module"> inline en :151 que 'self' NO cubre):
// middleware: res.locals.cspNonce = crypto.randomBytes(16).toString('base64')
helmet({ contentSecurityPolicy: { directives: {
  'script-src': ["'self'", (req,res)=>`'nonce-${res.locals.cspNonce}'`, 'https://releases.transloadit.com', 'https://cdnjs.cloudflare.com'],
  'style-src': ["'self'", 'https://cdnjs.cloudflare.com', "'unsafe-inline'"], // o nonce en <style> si lo hubiera
} } });
```
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(scale/security): sesión Redis + rate-limit + helmet/CSP; cookie por Host`.

### Task 5.3: Reescribir `uppy.routes.ts` (sin doble-auth, nuevos campos)
**Files:** Rewrite: `src/modules/companion/uppy.routes.ts`; Test: `uppy.routes.test.ts`
- [ ] **Step 1: Test:** `serveUppyPage` usa `req.user` ya poblado por `attachUser` (**no** vuelve a llamar `resolveSession`; cierra H12/Q10); deriva plugins de `brand.upload.plugins`; usa `auth.signInUrl` para el 302 sin cookie; escaping anti-XSS intacto; `Cache-Control:no-store`.
- [ ] **Step 2:** FAIL. **Step 3:** Reescribir eliminando la doble autenticación y los campos legacy; `getEnabledPlugins` deriva de `upload.plugins`. **Step 4:** PASS. **Step 5:** Commit `refactor(uppy): sin doble-auth, plugins tipados, nuevos campos`.

### Task 5.4: SRI en CDN + nonce en el `<script>` inline de `uppy.html` (compatibilidad CSP)
**Files:** Modify: `src/modules/companion/uppy.html`, `src/modules/companion/uppy.routes.ts`; Test: `uppy.routes.test.ts`
> **Motivo (hallazgo auditoría codex, ALTO):** `uppy.html:151` contiene un `<script type="module">` inline grande (importa `./uppyModal.js` y usa placeholders inyectados). El CSP `script-src 'self'` de Task 5.2 lo **bloquearía** → `/uppy` no arranca. Se resuelve con **nonce** (no con `'unsafe-inline'`, que anularía la protección).
- [ ] **Step 1: Test:** (a) el HTML servido contiene `integrity="sha384-…"` + `crossorigin` en los `<script>`/`<link>` de **CDN** (transloadit, cdnjs); (b) el `<script type="module">` inline lleva `nonce="<valor>"` **igual** al del header CSP (`res.locals.cspNonce`); (c) **test de regresión CSP:** el nonce del header y el del `<script>` coinciden (si no, Uppy no inicializaría).
- [ ] **Step 2:** FAIL. **Step 3:** Añadir `integrity`+`crossorigin="anonymous"` a los recursos de CDN; añadir el placeholder de nonce al `<script type="module">` de `uppy.html` y rellenarlo en `serveUppyPage` con `res.locals.cspNonce`. **Step 4:** PASS. **Step 5:** Commit `security(uppy): SRI en CDN + nonce CSP para el script inline`.

### Task 5.5: Folders — conservar con degradación (decisión SA3)
**Files:** Modify: `src/modules/folders/folders.service.ts`; Test: `folders.service.test.ts`
- [ ] **Step 1: Test:** `fetchFolders` con `brand.public?.foldersUrl` ausente → `[]` (sin error); respuesta no-ok / JSON inesperado / excepción de red → `[]` + `logger.warn`; happy path → lista parseada.
- [ ] **Step 2:** FAIL. **Step 3:** Mantener `folders.service` leyendo `brand.public?.foldersUrl` (opcional en el contrato), degradación silenciosa a `[]` con `logger.warn` (no `console`). Sigue inyectándose `FOLDERS_DATA_VALUE` en `uppy.routes` (Task 5.3). **Step 4:** PASS. **Step 5:** Commit `feat(folders): conservar con degradación (SA3)`.

---

## FASE 6 — Secretos y config  ·  ~1-2 días

### Task 6.1: Carga desde AWS Secrets Manager
**Files:** Create: `src/lib/secrets.ts`, `secrets.test.ts`; Modify: `brand.service.ts`, `config/env.ts`, `env.schema.ts` · **Produces:** `loadBrandSecrets(slug)`.
- [ ] **Step 1: Test** (mock `@aws-sdk/client-secrets-manager` con `aws-sdk-client-mock`): devuelve `{s3, providers}`; fallback a env si `SECRETS_SOURCE=env`; fail-fast si falta un secreto requerido.
- [ ] **Step 2:** FAIL. **Step 3:** `pnpm add @aws-sdk/client-secrets-manager@^3`; implementar (`GetSecretValueCommand` + cache al boot). Ampliar `env.schema.ts` con `REDIS_URL`, `BRAND_FORCE?`, `SECRETS_SOURCE ('aws'|'env')`, `LOG_LEVEL?`. `brand.service` llama `loadBrandSecrets`. **Step 4:** PASS. **Step 5:** Commit `feat(secrets): credenciales por marca desde Secrets Manager`.

---

## FASE 7 — Documentación y smoke test  ·  ~1-2 días

### Task 7.1: `.env.example`, docs, `verify-brand-config`
**Files:** Modify: `.env.example`, `CLAUDE.md`, `README.md`, `scripts/verify-brand-config.ts`
- [ ] **Step 1:** `.env.example`: `EDO_BRAND_OVERRIDE` (ejemplo stage real), `BRAND_FORCE`, `REDIS_URL`, `SECRETS_SOURCE`, y el requisito de fijar el MISMO override que designer/node-socket. **Step 2:** Actualizar `CLAUDE.md`/`README` (Host resolution, contrato abeduls3, Redis, secretos). Adaptar `verify-brand-config.ts` (registro base + override + validación de whoami target). **Step 3:** `npx tsx scripts/verify-brand-config.ts` con `EDO_BRAND_OVERRIDE` → imprime config efectiva sin secretos. **Step 4:** Commit `docs: modelo alineado con abeduls3`.

### Task 7.2: Smoke test contra stage (SA1/SA2/SA4)
**Files:** Create: `scripts/smoke-whoami-stage.ts`
- [ ] **Step 1:** Script que, con una cookie de sesión de prueba de edo (variable de entorno, no commiteada), ejecuta el flujo real `resolveSession(edo-stage, cookie)` contra `edonext-app.stage.entourageyearbooks.com` y valida `200` + **`user.id` canónico** presente (y `edoId` como extra). Imprime la key S3 que generaría el key-builder (`original/{id}/.../[UPID_{orderId}]/...`) para **contrastar el esquema con el equipo edo** (confirmar SA1: `UPID_{orderId}` y bucket `entourage-uploads`). Documentar cómo obtener la cookie.
- [ ] **Step 2:** Ejecutar como gate manual antes de escribir a prod. Confirmar con el equipo edonext/infra: (SA1) esquema `UPID` + bucket, (SA2) DNS/TLS de `companion[.stage].entourageyearbooks.com`, (SA4) cookie stage `Domain=.entourageyearbooks.com` + `Secure`. **Step 3:** Commit `test(smoke): validación stage de edo (whoami + esquema S3)`.

---

## FASE 8 — Diferido (documentado, no ahora)

- **8.1 STS scoped por tenant (TVM/ABAC)** — activar por nº de marcas/compliance. (Spec §10, benchmark #8.)
- **8.2 Paquete compartido `@ecs/brands`** — extraer slugs/contract/identity; la extracción **no es mecánica** por dos divergencias conscientes del Companion vs abeduls3: (a) el rename `imageSource.upload`→`upload` (D2); (b) la variante `capsule` del Companion añade `whoamiUrl`+`whoamiAllowedHosts` (D5.b), quedando estructuralmente idéntica a `partner-whoami` salvo el tag `kind` (en abeduls3 `capsule` no tiene campos whoami). Reconciliar al extraer.
- **8.3 OpenTelemetry + métricas por marca** (`@opentelemetry/auto-instrumentations-node` + `prom-client`).
- **8.4 Escaneo antivirus asíncrono** (S3 event → Lambda ClamAV). (Benchmark #7.)
- **8.5 Presigned POST** con `content-length-range` (enforcement server-side real de tamaño; completa H13). (Spec D14.)
- **8.6 Lifecycle S3 por marca** (retención/borrado — compliance datos de menores). (Spec §10.)
- **8.7 `uppyModal.ts` tipado** — quitar `@ts-nocheck` y los ~17 `any` (auditoría **H21**), resolver el TODO de URL por entorno.
- ~~**8.8 CORS exact-origins**~~ — **DESCARTADO (decisión SA4):** se mantiene el echo de `*.<apex>` de `corsForBrand` (subdominios a cualquier profundidad). No se migra a orígenes exactos.
- **8.9 Redis real en CI** (testcontainers) en vez de `ioredis-mock` para lógica de seguridad. (Spec §8 nota.)
- **8.10 Habilitar abe/capsule** con endpoint externo confirmado (spec D5.b) si no entró en el MVP.

---

## Self-Review (cobertura spec→plan y auditoría)

**Decisiones D1–D14:** D1→Fase2+8.2; D2→2.2; D3→2.4; D4→2.5,5.1; D5→3.1,3.2,3.3 (+enrichEdo, breaker half-open, cache full-user, orden breaker-first); D6→4.1 (**id canónico**, no edoId); D7→1.2,5.2 (cookie path/name); D8→6.1; D9→4.3 (+validHosts H7); D10→1.1,1.3,1.4; D11→Fase0; D12→0.0 (ADR primero); D13→5.2 (wiring sendCommand); D14→4.2 (parcial, `limits.maxUploadBytes`)+8.5. ✓

**Auditoría H1–H24:** H1/H2→4.3; H3→0.1; H4→5.2; H5→0.2; H6→5.2/5.4; **H7→4.3 (con test)**; H8→5.2; H9/H10→1.1/1.4; H11→1.3; **H12→5.3 (doble-auth eliminada)**; H13→4.2 parcial+8.5; H14→6.1; H15→0.3; H16→0.4; H17→0.0; H18→0.5b; H19→1.3; H20→0.5a; **H21→8.7**; H22→0.5c; H23→2.7; H24→infra(spec §10). ✓

**Ficheros de alta superficie con task explícito:** `uppy.routes.ts`→5.3; `folders.service.ts`→5.5; `test-utils/{fixtures,http}`→2.7. ✓

**Supuestos a confirmar (spec §2):** SA1 (id canónico + esquema `UPID_{orderId}`)→7.2; SA2 (companionHosts `companion.*`)→2.3/7.2; SA3 (folders, conservar)→5.5; SA4 (cookie stage + CORS wildcard)→7.2. ✓

**Anti-typecheck-roto:** cutover atómico en 2.7; cada fase deja el árbol verde. ✓
```
