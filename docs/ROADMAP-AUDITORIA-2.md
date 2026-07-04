# Auditoría de seguimiento — `companion-platform-multi-brand` (post-merge PR #8)

> Consultoría técnica externa (Fable 5) · solo lectura · rama `main` (rediseño abeduls3 Fases 0-7 mergeado).
> Fecha: 2026-07-03 · Método: `pnpm typecheck` (limpio), `pnpm test` (**25 files / 350 tests passed**), lectura de `src/**`, CI, Dockerfile, `.github/**`, scripts, config.
> Coverage actual: **89.19% lines / 84.47% branches / 95.03% funcs** (thresholds 70/60/70/70).
>
> Este documento es el seguimiento de `docs/ROADMAP-AUDITORIA.md` (auditoría original del 2026-07-02, sobre la arquitectura previa al rediseño). El plan de implementación de las mejoras accionables en el repo vive en `docs/superpowers/plans/2026-07-03-companion-mejoras-post-auditoria.md`.

## Veredicto general

El rediseño está **muy por encima de la madurez de la auditoría original**. De los 24 hallazgos (H1–H24), **19 están RESUELTOS con evidencia en código y tests**, 2 son PARCIALES por decisión de diseño consciente (H13 firma S3, documentada como D14), 1 sigue ABIERTO por diseño diferido a Fase 8 (H21 `uppyModal.ts`), y 1 es no-verificable-en-repo (H24 SSE/bucket). Las tres brechas "críticas" originales (SSRF `allowLocalUrls`/`uploadUrls`, build de Docker roto, `MemoryStore`) están cerradas y **cubiertas por tests**. La capa de seguridad de request (SSRF gate, orden de pasos del session-resolver como propiedad de seguridad, breaker Redis, escaping anti-XSS, CSP por marca con nonce, doble capa BOLA, rate-limiting global + por-usuario) es sólida y coherente con la spec. El riesgo residual real ya **no está en el código de aplicación**, sino en (a) **verificaciones externas pendientes de infra** (SA1/SA2/SA4 — el bucket `entourage-uploads` es compartido con el pipeline legacy de edonext), (b) un par de **trampas operativas de Railway** (readiness HeadBucket vs. IAM, hops del proxy, nº de réplicas) y (c) deuda menor diferida conscientemente. Es un código listo para un MVP de producción de `edo` **una vez pasado el smoke test contra stage**.

## Tabla H1–H24: estado

| ID | Estado | Evidencia | Nota |
|----|--------|-----------|------|
| H1 `allowLocalUrls:true` fijo | ✅ RESUELTO | `companion.factory.ts:212` `allowLocalUrls: env.protocol === 'http'` | Solo dev; test dedicado en `companion.factory.test.ts` |
| H2 `uploadUrls:['*']` | ✅ RESUELTO | `companion.factory.ts:144-163` `buildUploadUrls` deriva de companionUrl/companionHosts/s3 bucket, anclado+escapado | Nunca `*` |
| H3 `.dockerignore` excluye `scripts/` | ✅ RESUELTO | `.dockerignore` ya no lista `scripts`; `git ls-files` incluye `scripts/build-assets.mjs` | Build de imagen ya no roto |
| H4 `MemoryStore` | ✅ RESUELTO | `server.ts:127-160` `connect-redis` `RedisStore` + `saveUninitialized:false` | Habilita ≥2 réplicas |
| H5 CI no corre `build` | ✅ RESUELTO | `.github/workflows/ci.yml`: `lint → typecheck → build → test:coverage` | 4 gates |
| H6 sin helmet/CSP/SRI | ✅ RESUELTO | `server.ts:307-331` helmet+CSP por marca; `uppy.html:9,150,152,251` `integrity=`+`crossorigin` en todo `<script>/<link>` externo | Ver N1 (gap picker) |
| H7 sin `validHosts` | ✅ RESUELTO | `companion.factory.ts:121-129` `buildValidHosts` anclado `^...$`+escapado (cierra BAJO-2 del propio Companion) | |
| H8 sin rate limiting | ✅ RESUELTO | `server.ts:197-247` dos limitadores Redis (global per-IP + per-brand+user) | |
| H9 `console.*` | ✅ RESUELTO | `lib/logger.ts` Pino; sin `console.*` en `src/**` | |
| H10 sin correlación de request | ✅ RESUELTO | `server.ts:271-275` pino-http + `runWithContext` (AsyncLocalStorage `requestId`) | |
| H11 solo liveness | ✅ RESUELTO | `server.ts:360-372` `/api/readyz` (Redis PING + S3 HeadBucket); `/api/healthz` liveness | Ver N2 (HeadBucket/IAM) |
| H12 auth por request sin caché/breaker + doble auth | ✅ RESUELTO | caché Redis 45s `session-resolver.ts:151-159,223-227`; breaker `whoami-breaker.ts`; `attachUser`/`requireAuth` reusan `req.sessionResult` (`auth.middleware.ts:38,91`); `serveUppyPage` reusa `req.user` (`uppy.routes.ts:219`) | 3 round-trips → 1 |
| H13 sin límite de tamaño en firma S3 | 🟡 PARCIAL (por diseño D14) | `s3.controller.ts:47-71,140-141` valida `Content-Length`/`Content-Type` DECLARADOS; multipart no valida bytes (`:183-194`, documentado) | Enforcement real = presigned POST, diferido Fase 8 |
| H14 config blob JSON en env | ✅ RESUELTO/OBSOLETO | registro en código `registry.ts` + override auth-only `identity.ts` + secretos por-var `secrets.ts` | Límite 64KB ECS N/A en Railway |
| H15 sin linter/formatter | ✅ RESUELTO | `biome.json`; `pnpm lint` en CI | |
| H16 sin dep-scan/SAST/secretos | ✅ RESUELTO | `.github/dependabot.yml` + `codeql.yml` + `gitleaks.yml` (+`.gitleaks.toml`) | |
| H17 pool 1 proceso sin documentar | ✅ RESUELTO | `docs/adr/ADR-001-tenancy-pool-bridge.md` (pool + escape `BRAND_FORCE`) | Ver N7 (réplicas reales) |
| H18 código muerto `s3Client.ts` (default 7d) | ✅ RESUELTO | `s3Client.ts` solo tiene `getS3Client`; `uploadFile`/`downloadFileAsBuffer`/`generateSignedUrl` eliminados | |
| H19 graceful shutdown incompleto | ✅ RESUELTO | `index.ts:38-64` force-exit 10s `.unref()` + 503 en health durante drain (`server.ts:349,361`) | Caveat WS de Companion documentado (sin handle público) |
| H20 Docker corre como root | ✅ RESUELTO | `Dockerfile` `USER node` + `--chown=node:node` | |
| H21 `uppyModal.ts` `@ts-nocheck`+`any` | 🔴 ABIERTO (diferido Fase 8) | `uppyModal.ts:1` `@ts-nocheck`; ~22 `any`/`@ts-ignore` | Excluido de coverage/typecheck; fuera de alcance por spec §1.2 |
| H22 ficheros sueltos en raíz | ✅ RESUELTO | movidos a `docs/legacy/` (REAME.GOOGLE, metadata-delete.json, uppy-test.html, code-workspace, arquitecture.png) | Biome excluye `docs/legacy` |
| H23 campos legacy sin retiro | ✅ RESUELTO/OBSOLETO | esquema legacy eliminado en cutover Task 2.7 (`env.schema.ts:3-13`) | |
| H24 SSE no forzado / bucket no verificable | 🟠 ABIERTO — **verificar en infra** | sin `ServerSideEncryption` en `s3.controller.ts` (grep vacío); sin IaC de bucket | Ver N9 |

## Hallazgos nuevos (introducidos/expuestos por el rediseño o no cubiertos por la auditoría vieja)

> Nota de numeración: la lista salta de **N7 a N9** — **no existe N8** (hueco de etiqueta heredado del triage). Son **9 hallazgos nuevos**. Los IDs `N9`/`N10` se conservan estables porque ya se referencian en este roadmap y en el plan de implementación.

| ID | Sev | Cat | Hallazgo (verificado) | Evidencia | Nota |
|----|-----|-----|------------------------|-----------|------|
| **N1** | 🟡 | SEC | **CSP `script-src` no incluye `https://apis.google.com`**, que necesita el loader del Google Drive/Photos Picker. `csp.ts` sí añade orígenes Google a `connect-src`/`frame-src`/`img-src` cuando el picker está activo, pero `script-src` es fijo (`self`,nonce,transloadit,cdnjs). | `server.ts:310-315` vs `csp.ts:40-45,63-102` | **Latente**: edo (único servable) usa solo `Facebook`/`Url`. Rompería el picker si abe/picaboo/edo lo habilitan. Añadir `apis.google.com` a `script-src` (y confirmar en el smoke del picker). |
| **N2** | 🟠 | OPS | **`/api/readyz` usa `HeadBucket`, que exige permiso a nivel de bucket.** Si las credenciales de edo siguen least-privilege (solo `PutObject`/multipart sobre `original/*`), `HeadBucket` devuelve 403 y **readyz nunca pasa a OK → Railway nunca enruta tráfico**. | `server.ts:94-118` (`HeadBucketCommand`) | Verificar que la IAM policy del Companion permite `s3:ListBucket`/HeadBucket, o cambiar la sonda a un check permitido (p.ej. un `HeadObject` a una key centinela, o solo Redis). Trampa operativa real. |
| **N3** | 🟡 | SEC/OPS | **`trust proxy` = `1` fijo, pero el limitador global keyea por `req.ip`.** En Railway el nº de saltos de proxy debe ser exactamente 1 para que `req.ip` sea el cliente real; si hay 2 (edge+router), o se limita a todos juntos por una IP de proxy, o un cliente podría falsear `X-Forwarded-For`. express-rate-limit emite `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` en este caso. | `server.ts:264,245` | Verificar hops reales de Railway y ajustar `trust proxy`. **Verificar en infra.** |
| **N4** | ⚪ | SEC | **Sin caché negativa de whoami**: un `401` hace `recordSuccess` pero **no** cachea, así que cada request con cookie fresca/basura dispara un fetch real al partner. | `session-resolver.ts:186-189` (no hay `redis.set` en la rama 401) | Mitigado por el limitador global per-IP (MEDIO-1) y porque 401 no abre el breaker. Aceptable; considerar micro-caché negativa si el volumen anónimo crece. |
| **N5** | ⚪ | SEC | **`folders.service` reenvía la cookie de sesión a `foldersUrl` sin pasar por el SSRF gate** (`resolveValidatedWhoamiTarget`), a diferencia de whoami. | `folders.service.ts:38,50` | `foldersUrl` es code-only (registry, no overridable) y ningún brand servable lo fija hoy → no atacante-controlable. **Latente**: si se añade un `foldersUrl`, saltaría el allowlist. Enrutar por el mismo gate. |
| **N6** | ⚪ | SEC | **Breaker `recordFailure`: `INCR` + `SET open` no atómicos** (dos round-trips); un `recordSuccess` concurrente puede reabrir espuriamente ≤30s. | `whoami-breaker.ts:97-106` (documentado como BAJO-3) | Fail-closed se preserva; auto-sana. Fix = Lua/MULTI, diferido a Fase 8.9 (ioredis-mock no ejecuta Lua). |
| **N7** | 🟠 | OPS | **No hay IaC de Railway en el repo** (ni `railway.json/toml`, `nixpacks.toml`, `Procfile`). Path de readiness, nº de réplicas y grace period de SIGTERM son gestión de dashboard. **Todo el beneficio del estado en Redis (≥2 réplicas) queda sin realizar si solo corre 1 réplica.** | `git ls-files` sin IaC; `Dockerfile` HEALTHCHECK apunta a `/api/healthz` (liveness) | Confirmar ≥2 réplicas y que Railway sondea `/api/readyz`. Considerar versionar la config de Railway. **Verificar en infra.** |
| **N9** | 🟠 | SEC | **El "aislamiento por bucket" (D6/SA1) es un bucket COMPARTIDO** (`entourage-uploads`) con el pipeline legacy de edonext, no un bucket exclusivo del Companion; la única separación es el prefijo `original/{id}/`. Sin SSE forzado en código (H24). | `registry.ts:50`; `s3.key-builder.ts:26-40`; sin `ServerSideEncryption` | El smoke test (SA1) es **el gate**: confirmar con edonext política de bucket, alcance de las creds del Companion y SSE por defecto antes de escribir a producción. **Verificar en infra.** |
| **N10** | ⚪ | CAL | **`express.json()`/`urlencoded` globales** antes de resolución de marca y rate-limit; parsean cuerpo en toda ruta (incl. passthrough a Companion y OAuth callbacks). | `server.ts:277-278` | Límite por defecto 100kb acota abuso. Confirmar que no interfiere con rutas de Companion que esperen stream crudo. Bajo. |

> No confirmados como problema (revisados y descartados): `getS3Client` siempre se llama con params explícitos desde `brand.service.ts:60`, así que el singleton nunca cachea y **cada marca obtiene su propio `S3Client`** (aislamiento correcto). El orden del `session-resolver` (cookie-header antes del breaker) está implementado tal cual la spec. `/api/brands` vista básica sin auth ya está trackeado como BAJO-1 (TODO en `server.ts:374-381`).

## Roadmap "qué sigue"

### Quick wins (alto impacto / bajo esfuerzo — días)

| # | Sev·Cat | Qué | Por qué | Esfuerzo | Archivos |
|---|---------|-----|---------|----------|----------|
| Q1 | 🟠 OPS | **Ejecutar el smoke test SA1/SA2/SA4 contra stage y obtener sign-off de edonext** antes de cualquier escritura a `entourage-uploads`. | Es el gate explícito del diseño (N9): el bucket es compartido con el pipeline legacy; hay que confirmar que edonext consume por la key notificada, no por convención de path, + `Domain=.entourageyearbooks.com`/`Secure` de la cookie (ADR-014). | S (operativo) | `scripts/smoke-whoami-stage.ts` (ya existe) |
| Q2 | 🟠 OPS | **Verificar la IAM policy vs. `HeadBucket` de readiness** (N2); si es least-privilege, cambiar la sonda S3. | Evita el fallo silencioso "readyz nunca OK → sin tráfico" en el primer deploy. | S | `server.ts:94-118` + IAM (infra) |
| Q3 | 🟠 OPS | **Confirmar ≥2 réplicas y readiness path `/api/readyz` en Railway** (N7); versionar `railway.json` si es posible. | Sin ≥2 réplicas, toda la complejidad Redis (sesión/caché/breaker/rate-limit compartidos) no aporta nada y el blast radius del ADR sigue en pie. | S | infra + repo |
| Q4 | 🟡 SEC | **Verificar hops de proxy de Railway y ajustar `trust proxy`** (N3). | Corrección del rate-limit per-IP y prevención de spoofing de XFF. | S | `server.ts:264` + infra |
| Q5 | 🟡 SEC | **Añadir `https://apis.google.com` a `script-src`** (N1), gated por `usesGooglePicker`, alineado con `csp.ts`. | Cierra el gap latente antes de que cualquier marca habilite el Google Picker. | S | `server.ts:310-315`, `core/csp.ts` |
| Q6 | 🟠 SEC | **Confirmar SSE por defecto del bucket + forzar `ServerSideEncryption` en `PutObject`/`CreateMultipartUpload`** (H24/N9). | Defensa en profundidad si el bucket no tuviera cifrado obligatorio; datos potencialmente de menores (spec §10). | S | `s3.controller.ts:145,198` + infra |

### Corto plazo (1–2 semanas)

| # | Sev·Cat | Qué | Por qué | Esfuerzo |
|---|---------|-----|---------|----------|
| C1 | 🟡 DEL | **Añadir `docker build` (y opcionalmente un smoke `docker run` + curl a `/api/healthz`) como job de CI.** | CI valida `pnpm build` pero no que la imagen final arranque; el runtime real es Docker en Railway. | M |
| C2 | 🟡 SEC | **Decidir y ejecutar el endurecimiento de `/api/brands`** (BAJO-1 ya trackeado + `DEBT_TECH.md §1`): exigir `HEALTH_CHECK_KEY` también para la vista básica o restringir a hosts de operador. | Hoy la vista básica filtra todos los slugs/nombres de marca sin auth en cualquier Host. | S |
| C3 | ⚪ SEC | **Enrutar `foldersUrl` por el SSRF gate** (N5) aunque sea code-only hoy. | Evita reintroducir un fetch sin allowlist si se activa Dropbox/GoogleDrivePicker. | S |
| C4 | ⚪ OPS | **Micro-caché negativa (TTL corto) para `401`/`unauthenticated`** (N4). | Reduce amplificación de fetches al partner desde volumen anónimo con muchas IPs (que el limitador per-IP no acota). | M |

### Medio / largo plazo (3+ semanas — Fase 8 y más)

| # | Sev·Cat | Qué | Por qué | Esfuerzo |
|---|---------|-----|---------|----------|
| M1 | 🟡 SEC | **Enforcement server-side de tamaño en multipart: migrar la firma a presigned POST con `content-length-range`** (cierra H13 del todo). | Hoy el límite es declarativo; un cliente puede mentir el tamaño real (coste/DoS). Requiere tocar `uppyModal.ts` (browser). | L |
| M2 | 🔴 CAL | **Tipar `uppyModal.ts` (quitar `@ts-nocheck` + ~22 `any`), idealmente extraído a paquete** (H21). | Todo el bundle de navegador está fuera del typecheck; footgun de regresiones. | L |
| M3 | ⚪ SEC | **Atomizar el breaker (INCR+SET open con Lua/MULTI)** cuando CI corra contra Redis real (testcontainers) (N6/BAJO-3). | Elimina la reapertura espuria ≤30s; `ioredis-mock` no ejecuta Lua, de ahí la dependencia de testcontainers. | M |
| M4 | 🟡 ARQ | **STS/TVM + ABAC scoped por tenant** (Fase 8 del ADR) si/cuando se migre a AWS o un partner exija aislamiento IAM. | Hoy una access key por marca con acceso al bucket completo; STS reduce el blast radius de una fuga de credenciales. | L |
| M5 | ⚪ OPS | **OpenTelemetry + métricas Prometheus** (uploads, latencia whoami/firma, estado del breaker por marca). | Observabilidad de SLOs; el logging estructurado ya está, faltan métricas/trazas. | L |

> Ítems del roadmap original que **ya no aplican por Railway** (no relitigar): el argumento del límite de 64 KB de task-def ECS (H14) y el fallback a IAM instance role (parte de H24/2.3) — el diseño ya lo enmarca como "solo si se migra a AWS" (`secrets.ts:236-244`, D8). El escaneo antivirus (ClamAV) sigue fuera de alcance por decisión de la spec (§1.2).

## Top 5 recomendaciones (si solo pudieras hacer 5, en orden)

1. **Pasar el smoke test SA1/SA2/SA4 contra stage y obtener sign-off de edonext** (`scripts/smoke-whoami-stage.ts`) **antes de escribir a `entourage-uploads`**. Es el único riesgo bloqueante real: el bucket es compartido con el pipeline legacy y el esquema de key/cookie cross-apex depende de confirmación externa (N9/Q1).
2. **Verificar la IAM policy contra `HeadBucket` de `/api/readyz`** — si es least-privilege, la instancia nunca pasará a "ready" y Railway no enrutará tráfico (N2/Q2). Es la trampa más probable del primer deploy.
3. **Confirmar ≥2 réplicas y que Railway usa `/api/readyz`** para routing — sin esto, toda la infraestructura Redis del rediseño no compra nada y el blast radius del ADR-001 sigue vigente (N7/Q3).
4. **Ajustar `trust proxy` a los hops reales de Railway** para que el rate-limit per-IP sea correcto y no falseable (N3/Q4).
5. **Cerrar H24/N9 en infra**: SSE por defecto del bucket + política que acote las credenciales del Companion (idealmente a prefijo de escritura), y forzar `ServerSideEncryption` en código como defensa en profundidad (Q6). Datos potencialmente de menores.

Todo lo demás (H13 presigned POST, H21 tipado de `uppyModal`, N6 atomicidad del breaker, STS/TVM) es deuda consciente y correctamente diferida a Fase 8 — no debe bloquear el MVP de `edo`.
