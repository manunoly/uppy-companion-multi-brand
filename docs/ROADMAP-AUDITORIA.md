# Auditoría técnica y Roadmap — `companion-platform-multi-brand`

> Consultoría técnica externa (arquitectura backend, seguridad de aplicaciones, SaaS multi-tenant, prácticas de ingeniería).
> Fecha: 2026-07-02 · Rama auditada: `feat/vitest-suite` · Alcance: repositorio completo (solo lectura).
> Método: lectura de código fuente, config, tests, CI, Dockerfile y scripts; ejecución de `pnpm typecheck` y `pnpm test`; contraste contra un benchmark de industria 2023–2026 (ver Apéndice).

---

## 1. Resumen ejecutivo

- **Veredicto general:** proyecto **sólido en seguridad de aplicación a nivel de request** (auth cookie-only, defensa BOLA en dos capas, CORS por marca HTTPS-only, escaping anti-XSS, secretos enmascarados, validación Zod fail-fast) y con **buena base de pruebas** (163 tests en 13 ficheros, todos verdes; `typecheck` limpio; CI en GitHub Actions). Es un código maduro para su tamaño. Las brechas reales no están tanto en "la lógica de negocio insegura" como en **la capa de plataforma/operación**: escalabilidad, observabilidad, cadena de entrega y un par de valores por defecto peligrosos heredados de Companion.
- **Fortalezas clave confirmadas:** modelo cookie-only sin token en URL (`auth.service.ts`), BOLA defendido server-side (`s3.key-builder.ts` + `sendIfKeyNotOwned`), presigned URLs de **300 s** (dentro del estándar ≤15 min), CORS con echo de origen HTTPS-only y `Allow-Credentials` (`core/cors.ts`), y anti-XSS real en la inyección de `uppy.html`.
- **TOP-3 riesgos/brechas críticas:**
  1. **`allowLocalUrls: true` fijo para todas las marcas** + `uploadUrls` por defecto `['*']` → superficie de **SSRF** en un entorno cloud (Companion podría ser inducido a alcanzar `169.254.169.254`/servicios internos, y a hacer POST de uploads a cualquier host).
  2. **`.dockerignore` excluye `scripts/`** mientras el `Dockerfile` ejecuta `pnpm run build` → `node scripts/build-assets.mjs`. **La imagen de producción no se puede construir tal cual** (el bundle de navegador nunca se genera). Como **CI no corre `pnpm build`**, el fallo solo aparece en el deploy.
  3. **`express-session` usa el `MemoryStore` por defecto** (no hay `store` configurado) → memory leak conocido + **imposibilidad de escalar horizontalmente** (el estado OAuth no se comparte entre instancias). Esto choca de frente con la recomendación de industria de correr ≥2 réplicas + Redis.
- **Naturaleza de las brechas:** mayoritariamente **operación/entrega/observabilidad**, no vulnerabilidades explotables hoy en la lógica de subida. Muchas ya están catalogadas en `DEBT_TECH.md` y `docs/ROADMAPFuturo.md` — este documento las prioriza, añade hallazgos nuevos y define un plan por fases.

---

## 2. Contexto y alcance

**Qué es el sistema (verificado):** servidor Express (Node ≥22, TS ESM NodeNext strict) que monta **una instancia aislada de `@uppy/companion` por marca** bajo `/{brandId}`, cada una con sus credenciales OAuth, bucket S3, backend de auth y dominio raíz. Resolución de marcas: `COMPANION_BRANDS` (CSV) → JSON en `<SLUG_UPPER_SNAKE>` → globales `COMPANION_*`/`AWS_*` → defaults. Deploy vía Docker (previsiblemente ECS/Fargate). Modelo de tenancy: **pool puro en un solo proceso**.

**Qué se revisó:** `src/**` (server, config, core/cors, brand, companion, auth, folders, lib/aws), `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`, `scripts/build-assets.mjs`, `package.json`, `.env.example`, `.gitignore`, `DEBT_TECH.md`, `docs/ROADMAPFuturo.md`, la suite de tests y la config de TS/Vitest.

**Método de verificación:** ejecución de `pnpm typecheck` (limpio) y `pnpm test` (**13 files / 163 tests passed**, 1.33 s). Búsquedas dirigidas para confirmar/refutar cada afirmación del brief (grep sobre `helmet`, `rate-limit`, `store`, `allowLocalUrls`, `validHosts`, usos de las funciones de `s3Client.ts`, etc.).

**Fuera de alcance / no verificable desde el repo:** configuración real de los buckets S3 (privacidad, SSE, bucket policy, OAC/CloudFront), definición de task de ECS, número de réplicas en producción, IAM policies. Donde aplica, se marca como **"verificar en infra"**.

---

## 3. Fortalezas confirmadas (con ficheros/líneas)

| # | Fortaleza | Evidencia |
|---|-----------|-----------|
| F1 | **Auth cookie-only, sin token en URL.** `extractToken` acepta `Authorization: Bearer` (server-to-server) → cookie de marca; **nunca** query param. La página `/uppy` no inyecta bearer token. | `auth.service.ts:27-41`; `uppy.routes.ts:254-266` |
| F2 | **Defensa BOLA en dos capas.** `buildS3Key` **lanza** si falta `req.user`; `sendIfKeyNotOwned` valida que la key pertenezca al prefijo `{brand}/original/{userId}/`. | `s3.key-builder.ts:52-55`; `s3.controller.ts:38-57` |
| F3 | **Presigned URLs de corta duración: 300 s** (5 min) en `signS3` y `signPart`. Dentro del estándar (≤15 min). | `s3.controller.ts:95, 178` |
| F4 | **CORS por marca HTTPS-only en prod**, echo del origen (nunca `*`), `Allow-Credentials: true`, `res.vary('Origin')`, preflight 204. | `core/cors.ts:22-77` |
| F5 | **Anti-XSS real** en inyección a `uppy.html`: `toJsStringLiteral`/`safeJsonForHtmlScript` escapan `</`, `<!--`, `-->`, U+2028/U+2029; página con `Cache-Control: no-store`. | `uppy.routes.ts:22-49, 276` |
| F6 | **Secretos enmascarados** (`****...last4`) en `/api/brands`; comparación de `HEALTH_CHECK_KEY` con `timingSafeEqual`. | `server.ts:37-42, 92-96` |
| F7 | **Validación Zod fail-fast** al arrancar; `secret` ≥16; `superRefine` exige `rootDomain` cuando hay `auth.url`; JSON de marca inválido **aborta el arranque**. | `env.schema.ts`; `brand.schema.ts:74-85`; `env.ts:42-57` |
| F8 | **Fallback a IAM role** (Default Credential Provider Chain) cuando no hay claves explícitas. | `lib/aws/s3Client.ts:31-42` |
| F9 | **ACL eliminado** en `PutObject`/`CreateMultipartUpload` → respeta bucket policies. | `s3.controller.ts:91, 131` |
| F10 | **Open-redirect mitigado** (`safePath` fuerza rutas server-relative antes de construir `?redirect=`). | `uppy.routes.ts:107-108, 186-191` |
| F11 | **Sourcemap deshabilitado** en el bundle de prod para no filtrar el fuente TS al cliente. | `scripts/build-assets.mjs:16-18` |
| F12 | **Sesión por marca** con cookie scoping (`companion.sid.<brandId>`, `path=/<brandId>`, `httpOnly`, `secure`/`sameSite=none` en HTTPS), `trust proxy`. | `server.ts:64-77, 52` |
| F13 | **Suite de tests + CI.** 163 tests verdes, `typecheck` limpio; CI corre `typecheck` + `test:coverage` (umbral 70/60/70/70). Tests excluidos del bundle vía `tsconfig.build.json`. | `.github/workflows/ci.yml`; ejecución local |
| F14 | **Manejo de `unhandledRejection`/`uncaughtException`** y handlers de `SIGTERM`/`SIGINT`. | `index.ts:26-57` |

> Nota de calibración: F1 no significa "cookie-only estricto" — el header `Authorization: Bearer` **sigue siendo un camino válido** (diseño defendible para llamadas server-to-server). No es un defecto, pero conviene tenerlo presente al razonar sobre el modelo de amenaza.

---

## 4. Hallazgos y brechas vs industria (priorizado)

Severidad: 🔴 crítico · 🟠 alto · 🟡 medio · ⚪ bajo. Categoría: SEC (seguridad) · OPS (observabilidad/operación) · DEL (entrega/CI/deploy) · ARQ (arquitectura) · CAL (calidad/higiene).

| ID | Sev | Cat | Hallazgo (verificado) | Evidencia | Estándar de referencia |
|----|-----|-----|------------------------|-----------|------------------------|
| H1 | 🟠 | SEC | **`allowLocalUrls: true` fijo para todas las marcas.** En cloud habilita SSRF (IMDS `169.254.169.254`, servicios internos) vía el provider `Url`/fetch remoto de Companion. | `companion.factory.ts:126` | Benchmark #1 (allowlist anti-SSRF) |
| H2 | 🟠 | SEC | **`uploadUrls` por defecto `['*']`.** El allowlist anti-SSRF de destinos de subida de Companion está abierto salvo que la marca lo restrinja explícitamente. | `brand.service.ts:217` | Benchmark #1 |
| H3 | 🟠 | DEL | **`.dockerignore` excluye `scripts/`** pero el `Dockerfile` (`builder`) hace `COPY . .` + `pnpm run build` → `node scripts/build-assets.mjs`. El script no está en el contexto → **build de imagen roto / bundle de navegador nunca generado**. Latente porque CI no corre build. | `.dockerignore` (línea `scripts`), `Dockerfile:16-18`, `package.json:15` | 12-Factor V; build como gate |
| H4 | 🟠 | ARQ/OPS | **`express-session` sin `store` → `MemoryStore` por defecto.** Memory leak conocido + **bloquea escalado horizontal** (estado OAuth no compartido; sin sticky sessions falla el flujo). | `server.ts:64-77` (no hay `store`) | Benchmark #1 (Redis, sin sticky) |
| H5 | 🟠 | DEL | **CI no ejecuta `pnpm build`.** Una regresión en `build-assets.mjs`/esbuild o el problema H3 pasan CI y solo revientan en deploy. | `.github/workflows/ci.yml:26-30` | Benchmark #16 |
| H6 | 🟡 | SEC | **Sin headers de seguridad / `helmet`, sin CSP, sin SRI.** `/uppy` carga Uppy (`releases.transloadit.com`) y SweetAlert2 (`cdnjs`) sin `integrity=`; `uppyModal.ts` importa Uppy por ESM desde CDN. Compromiso de CDN = XSS en `/uppy`. | grep sin resultados de `helmet`; `uppy.html:8,148,149,246`; `uppyModal.ts:23` | Benchmark #5/#17; ya en `DEBT_TECH.md` Opción C |
| H7 | 🟡 | SEC | **Sin `COMPANION_CLIENT_ORIGINS`/`validHosts`/`COMPANION_DOMAINS`.** La validación de `redirect_uri` depende solo del `oauthDomain` derivado de `companionUrl`. | grep sin resultados | Benchmark #1 |
| H8 | 🟡 | SEC/OPS | **Sin rate limiting** (ni por IP ni por tenant). Endpoints de firma S3 y `/uppy` sin protección de abuso/DoS. | no hay `express-rate-limit` en deps | Benchmark #2; `ROADMAPFuturo.md` §9 |
| H9 | 🟡 | OPS | **Logging con `console.log/error`**, sin niveles, sin JSON estructurado, sin correlación por request. | ubicuo (`[server]`, `[s3]`, `[auth]`…) | Benchmark #11; `DEBT_TECH.md` §3 |
| H10 | 🟡 | OPS | **Sin correlación de requests** (`X-Request-Id`/`traceparent` + `AsyncLocalStorage`). | ausente | Benchmark #12 |
| H11 | 🟡 | OPS | **Health check solo liveness.** `/api/healthz` responde `{status:ok}` siempre; no hay readiness (`/readyz`) con chequeo de dependencias (auth backend, S3). | `server.ts:79-81`; `Dockerfile:31-32` | Benchmark #13 |
| H12 | 🟡 | OPS | **Auth backend consultado en cada request sin caché ni circuit breaker.** `attachUser` llama `authenticate()` (fetch) en cada request bajo `/{brand}`; además `serveUppyPage` **vuelve a autenticar** ignorando `req.user` → ~2 llamadas + folders = **3 round-trips por carga de página**. Acopla disponibilidad a la latencia del backend. | `auth.middleware.ts:58-76`; `uppy.routes.ts:233, 242` | Benchmark #3 (circuit breakers); `ROADMAPFuturo.md` §12 |
| H13 | 🟡 | SEC | **Sin límite de tamaño en la firma S3.** Se firman PUT/UploadPart por query (SigV4), no presigned POST, por lo que no hay `content-length-range`. Un cliente autenticado puede subir objetos de tamaño arbitrario (coste/DoS). | `s3.controller.ts:87-95, 170-179` | Benchmark #5 |
| H14 | 🟡 | ARQ/OPS | **Config de marca como blob JSON en env var** (`<SLUG_UPPER_SNAKE>`). Viola granularidad 12-Factor; roza el límite de 64 KB de task def ECS al crecer; sin rotación/auditoría por campo; diffs opacos. | `env.ts:27-58`; `.env.example` | Benchmark #9 |
| H15 | 🟡 | CAL | **Sin linter ni formatter** (ESLint/Prettier/Biome ausentes). | `package.json` (sin scripts lint/format) | Benchmark #15; `ROADMAPFuturo.md` §2 |
| H16 | 🟡 | DEL | **Sin escaneo de dependencias / SAST / secretos** (Dependabot, CodeQL/Snyk, gitleaks). | sin config en `.github/` | Benchmark #17 |
| H17 | 🟡 | ARQ | **Pool puro en un proceso sin Redis (probable task única).** Un event loop bloqueado degrada TODAS las marcas; sin réplicas no hay tolerancia a fallo. Decisión defendible pero **hay que documentar el blast radius** y planificar. | `server.ts` (montaje por marca en un proceso); ausencia de Redis/IaC | Benchmark #1/#3 |
| H18 | ⚪ | CAL | **Código muerto con footgun:** `uploadFile`/`downloadFileAsBuffer`/`generateSignedUrl` en `s3Client.ts` no se usan en ningún sitio; `generateSignedUrl` tiene default **604800 s (7 días)**, contradiciendo la disciplina de 300 s del controller. | `s3Client.ts:53-93`; grep sin usos | Benchmark #4 |
| H19 | ⚪ | OPS | **Graceful shutdown incompleto:** `server.close()` sin `setTimeout` de seguridad (sockets keep-alive idle no se cierran), sin 503 en health durante drenaje, y el WebSocket de Companion no se cierra explícitamente. | `index.ts:26-39` | Benchmark #13 |
| H20 | ⚪ | SEC | **Dockerfile corre como root** (sin `USER node`). La imagen `node:22-alpine` trae usuario `node`. | `Dockerfile:21-34` | Buenas prácticas de contenedor |
| H21 | ⚪ | CAL | **`uppyModal.ts` con `// @ts-nocheck`** y ~17 `any`; TODO pendiente de resolver la URL por entorno/marca. | `uppyModal.ts:1, 389, 399, 403, 422` | `DEBT_TECH.md` §2 |
| H22 | ⚪ | CAL | **Ficheros sueltos versionados en la raíz:** `REAME.GOOGLE.CONFIG.MD` (typo), `companion-server.code-workspace`, `metadata-delete.json`, `readme.arquitecture.png`, `uppy-test.html`. | `git ls-files` | Higiene |
| H23 | ⚪ | CAL | **Campos legacy sin plan de retiro** (`authUrl`/`authCookieName`/`publicBackendUrl`/`publicUploadUrl`), sin warning de deprecación. | `brand.schema.ts:54-57`; `brand.service.ts:199-228` | — |
| H24 | ⚪ | SEC | **SSE no forzado explícitamente** en las subidas (se confía en el cifrado por defecto del bucket, SSE-S3 desde ene-2023). **Privacidad de buckets / OAC / CloudFront no verificable** desde el repo (no hay IaC). | `s3.controller.ts` (sin `ServerSideEncryption`) | Benchmark #5/#6 — **verificar en infra** |

### Verificaciones puntuales solicitadas en el brief

- **`expiresIn` de presigned:** ✅ **300 s** en el código en uso (`signS3`, `signPart`). El único valor peligroso (7 días) está en `generateSignedUrl`, que es **código muerto** (H18).
- **`starts-with $key` en la policy firmada:** **N/A** — el sistema firma **PUT/UploadPart por query (SigV4)**, no presigned POST con policy, así que esa condición no aplica. La protección equivalente (**key generada server-side + validación de prefijo `sendIfKeyNotOwned`**) **sí está presente y es correcta**. No es una brecha; es un enfoque distinto y defendible.
- **Liveness vs readiness:** el health check es **liveness puro** (siempre `ok`). Falta readiness (H11).
- **Buckets privados / SSE / OAC:** **no verificable desde el repo** (sin IaC); el código no fuerza SSE (H24). Verificar en infra.
- **Una sola task / blast radius:** no hay orquestación en el repo; el `MemoryStore` (H4) confirma un diseño **asumido single-instance**. Documentar y planificar (H17).
- **Manejo de SIGTERM:** presente pero **incompleto** (H19).

---

## 5. QUICK WINS (alto impacto / bajo esfuerzo — ejecutables ya)

| # | Acción | Impacto | Esfuerzo | Ficheros | Pasos |
|---|--------|---------|----------|----------|-------|
| Q1 | **Arreglar `.dockerignore` (no excluir `scripts/`)** | 🔴 Desbloquea el build de la imagen de prod | 5 min | `.dockerignore` | Quitar la línea `scripts` (y revisar `test`). Verificar con `docker build .` que `pnpm run build` completa y emite `dist/modules/companion/uppyModal.js`. |
| Q2 | **Añadir `pnpm build` como paso obligatorio en CI** | 🟠 Detecta H3 y regresiones de esbuild antes del deploy | 15 min | `.github/workflows/ci.yml` | Añadir `- run: pnpm build` tras `typecheck`. Considerar añadir un `docker build` opcional. |
| Q3 | **Endurecer `allowLocalUrls`/`uploadUrls`** | 🟠 Cierra superficie SSRF | 30–60 min | `companion.factory.ts:126`, `brand.service.ts:217`, `brand.schema.ts` | Poner `allowLocalUrls: env.protocol === 'http'` (solo dev). Cambiar el default de `uploadUrls` de `['*']` a derivarlo de `s3.bucket`/`rootDomain`; documentar en `.env.example`. |
| Q4 | **`helmet` + CSP + SRI en `/uppy`** | 🟡 Mitiga XSS/supply-chain de CDNs | 1–2 h | nuevo middleware en `server.ts`; `uppy.html:8,148,149,246` | `pnpm add helmet`; CSP `script-src 'self' https://releases.transloadit.com https://cdnjs.cloudflare.com`; añadir `integrity="sha384-…"` + `crossorigin` a cada `<script>`/`<link>` externo. (Ya descrito en `DEBT_TECH.md` Opción C.) |
| Q5 | **`express-rate-limit` en `/api/*` y `/uppy`** | 🟡 Frena abuso/DoS de firma y de auth | 1 h | `server.ts`, `api.routes.ts` | `pnpm add express-rate-limit`; limitar `/:brand/api/uppy/*` (p.ej. 60/min por usuario/IP) y `/:brand/uppy` (30/min). |
| Q6 | **Eliminar código muerto de `s3Client.ts` (o testear + bajar el default a ≤900 s)** | ⚪ Elimina footgun de 7 días | 30 min | `s3Client.ts:53-93` | Si nadie lo usa, borrar `uploadFile`/`downloadFileAsBuffer`/`generateSignedUrl`; si se conservan, bajar el default a `900` y cubrir con tests. |
| Q7 | **`USER node` en el `Dockerfile`** | ⚪ No correr como root | 10 min | `Dockerfile` | Añadir `USER node` en el stage `runner` (ajustar permisos de `/app`). |
| Q8 | **Timeout de seguridad en el shutdown** | ⚪ Evita cuelgues en drenaje | 20 min | `index.ts:26-39` | Añadir `setTimeout(()=>process.exit(1), 10_000).unref()` tras `server.close()`; cerrar el WS de Companion. |
| Q9 | **Limpiar ficheros sueltos de la raíz** | ⚪ Higiene / menos confusión | 15 min | `REAME.GOOGLE.CONFIG.MD`, `metadata-delete.json`, `uppy-test.html`, `companion-server.code-workspace`, `readme.arquitecture.png` | Mover a `docs/` o borrar; renombrar el typo. |
| Q10 | **Evitar la doble autenticación en `/uppy`** | 🟡 −1 round-trip por carga | 20 min | `uppy.routes.ts:233` | Reusar `req.user` que ya pobló `attachUser` en vez de volver a llamar `authenticate()`. |

> Todos los quick wins son de bajo riesgo y no alteran el contrato de seguridad. Q1–Q2 deberían hacerse **primero**: sin ellos, el resto no llega a producción de forma fiable.

---

## 6. Roadmap por fases

### Fase 0 — Quick wins (ver §5)
Ejecutar Q1–Q10 en 1–2 días. Prioridad de arranque: **Q1 → Q2 → Q3 → Q4 → Q5**.

---

### Fase 1 — Corto plazo (1–2 semanas): entrega segura y observabilidad mínima

**1.1 Logger estructurado (Pino) + correlación por request** · 🟡 Prioridad ALTA · ~3–4 h
- **Qué:** sustituir `console.*` por `pino` + `pino-http`; propagar `requestId`/`brand`/`userId` con `AsyncLocalStorage`.
- **Por qué:** sin niveles ni JSON no hay operabilidad en CloudWatch/Datadog; sin correlación no se reconstruye un flujo (OWASP ASVS V7). Cubre H9, H10.
- **Cómo:** crear `src/lib/logger.ts`; middleware `pino-http` montado en `assembleApp`; reemplazar ~30 sitios (`[server]`, `[s3]`, `[auth]`…). Ver `DEBT_TECH.md` §3 y `ROADMAPFuturo.md` §3.
- **Ficheros:** nuevo `src/lib/logger.ts`; `server.ts`, `index.ts`, y todos los módulos con `console.*`.

**1.2 Readiness endpoint + shutdown alineado a ECS** · 🟡 ALTA · ~3 h
- **Qué:** añadir `GET /api/readyz` que verifique dependencias (al menos alcanzabilidad de S3 y opcionalmente auth backend con timeout corto) y que devuelva 503 durante el drenaje; mantener `/api/healthz` como liveness.
- **Por qué:** el ALB/orquestador necesita separar "reinícialo" (liveness) de "sácalo de tráfico" (readiness). Cubre H11, H19.
- **Cómo:** flag `shuttingDown` que readiness consulte; `Dockerfile`/target group ALB apuntando a `/api/readyz`; `deregistration_delay` alineado con el timeout del `server.close()`.
- **Ficheros:** `server.ts`, `index.ts`, `Dockerfile:31-32`.

**1.3 Linter + formatter como gate CI** · 🟡 MEDIA · ~2–3 h
- **Qué:** ESLint flat config (`eslint.config.mjs`) + `eslint-config-prettier`, o **Biome** (un binario, `biome migrate`). Añadir `lint` a CI.
- **Por qué:** consistencia y detección temprana. Cubre H15. Ver `ROADMAPFuturo.md` §2.
- **Ficheros:** `eslint.config.mjs`/`biome.json`, `package.json` (scripts), `ci.yml`.

**1.4 Escaneo de dependencias, SAST y secretos** · 🟡 MEDIA · ~2 h
- **Qué:** activar **Dependabot** (`.github/dependabot.yml`), **CodeQL** (`github/codeql-action`) y **gitleaks** (pre-commit + job CI) + push protection.
- **Por qué:** cubre H16 (benchmark #17). Bajo esfuerzo, nativo de GitHub.
- **Ficheros:** `.github/dependabot.yml`, `.github/workflows/codeql.yml`, hook/job de gitleaks.

**1.5 Límite de tamaño/tipo en la firma S3** · 🟡 MEDIA · ~2–3 h
- **Qué:** validar `Content-Length`/`Content-Type` declarados en la firma; opción de migrar `signS3` a **presigned POST** con `content-length-range` para que S3 rechace excedentes server-side.
- **Por qué:** hoy un PUT firmado permite subir tamaño arbitrario (H13). Con presigned POST se recupera `content-length-range` (y, si se quisiera, `starts-with $key`).
- **Ficheros:** `s3.controller.ts`, `s3.key-builder.ts`, `uppyModal.ts` (cliente).

---

### Fase 2 — Medio plazo (3–6 semanas): escalabilidad y resiliencia

**2.1 Redis para sesión + escalado a ≥2 réplicas** · 🟠 ALTA · ~1–2 días
- **Qué:** `connect-redis` como `store` de `express-session`; `COMPANION_REDIS_URL` + `COMPANION_REDIS_EXPRESS_SESSION_PREFIX`; `COMPANION_SECRET` idéntico en todas las réplicas; sin sticky sessions.
- **Por qué:** el `MemoryStore` actual (H4) tiene leak y **bloquea el escalado horizontal**. Es prerequisito para las ≥2 instancias que recomienda Uppy/Transloadit (benchmark #1). Reduce el blast radius (H17).
- **Cómo:** añadir `redis`/`connect-redis`; inyectar `store` en `buildSessionMiddleware`; documentar despliegue multi-instancia; validar el WebSocket de Companion con Redis pub/sub.
- **Ficheros:** `server.ts:64-77`, `index.ts`, `.env.example`, docs de deploy.

**2.2 Caché de auth + circuit breaker por dependencia** · 🟡 ALTA · ~1 día
- **Qué:** memoizar el resultado de `authenticate()` por token con TTL corto (p.ej. 30 s) y envolver las llamadas a `auth.url`/`foldersUrl` en un circuit breaker con timeout y fallback.
- **Por qué:** hoy cada request pega al backend (H12) y una carga de `/uppy` hace hasta 3 round-trips; una caída del backend tumba las subidas. Benchmark #3.
- **Cómo:** `src/modules/auth/auth.cache.ts` (Map con TTL o Redis); breaker sencillo (`opossum` o propio). Reusar `req.user` (Q10).
- **Ficheros:** `auth.service.ts`, `auth.middleware.ts`, `uppy.routes.ts`, `folders.service.ts`.

**2.3 Migrar secretos a AWS Secrets Manager (o dividir el blob)** · 🟡 MEDIA · ~2–3 días
- **Qué:** mover el JSON por marca desde la env var a Secrets Manager, inyectado con `secrets`/`valueFrom` en la task def; Parameter Store para config no sensible.
- **Por qué:** el blob JSON (H14) viola 12-Factor, roza el límite de 64 KB de ECS, no permite rotación/auditoría por campo y produce diffs opacos (benchmark #9).
- **Cómo:** cargador que resuelva `secretsmanager://<arn>` por marca al arrancar (manteniendo la validación Zod); rotación de OAuth client secrets vía Lambda custom.
- **Ficheros:** `env.ts`, `brand.service.ts`, IaC de la task def.

**2.4 Escaneo antivirus asíncrono de uploads** · ⚪ MEDIA · ~2–3 días
- **Qué:** evento S3 (ObjectCreated) → Lambda/worker con ClamAV que ponga en cuarentena/etiquete objetos infectados antes de exponerlos.
- **Por qué:** práctica de Uploadcare/Transloadit (benchmark #7). No hay AV hoy.
- **Cómo:** infra (S3 event → Lambda) fuera del proceso Companion; no toca la ruta caliente de subida.

---

### Fase 3 — Largo plazo / arquitectónico

**3.1 Aislamiento S3 con STS scoped por tenant (TVM / ABAC)** · 🟠 · ~1–2 semanas
- **Qué:** en vez de tener las credenciales de todos los tenants residentes en memoria (`brand.s3.client`), emitir credenciales STS temporales por request con `AssumeRole` inyectando `TenantID` como session tag (patrón Token Vending Machine) y ABAC `aws:PrincipalTag/TenantID` sobre el prefijo del bucket.
- **Por qué:** eleva el aislamiento del modelo pool (benchmark #3/#8); reduce el impacto de una fuga de credenciales en memoria.
- **Cómo:** servicio que cachee credenciales STS por tenant con TTL; IAM roles con condición de prefijo; ver la Prescriptive Guidance de AWS (Apéndice).

**3.2 Documentar formalmente la decisión pool + evaluar bridge/silo por marca grande** · 🟡 · ~2–3 días (ADR)
- **Qué:** un ADR que registre el modelo **pool en un proceso**, su blast radius, y los criterios para pasar marcas de alto volumen a un despliegue dedicado (bridge/silo).
- **Por qué:** compartir recursos exige más aislamiento explícito, no menos (benchmark #3). H17.

**3.3 Extraer `uppyModal.ts` a paquete propio con tipos firmes** · ⚪ · ~1 semana
- **Qué:** mover el módulo de navegador a `packages/uppy-modal`, tipar con `@uppy/core`/`@uppy/utils`, eliminar `// @ts-nocheck` y los ~17 `any`, resolver el TODO de la URL por entorno.
- **Por qué:** hoy todo el bundle de navegador está fuera del typecheck (H21). Ver `DEBT_TECH.md` §2 y `ROADMAPFuturo.md` §7.

**3.4 OpenTelemetry + métricas** · ⚪ · ~1 semana
- **Qué:** `@opentelemetry/auto-instrumentations-node` + métricas Prometheus (`prom-client`) por marca (uploads, latencia de auth, latencia de firma).
- **Por qué:** trazabilidad distribuida y SLOs (benchmark #4; `ROADMAPFuturo.md` §10).

**3.5 Rediseño de `/api/brands` (canal privado)** · 🟡 · ~2–3 h
- **Qué:** partir en `GET /api/brands` (público: solo `id`/`displayName`) y un endpoint de detalle restringido por red interna/mTLS o un CLI (`scripts/inspect-brands.ts`).
- **Por qué:** hoy la vista detallada (aunque enmascara secretos) es reconocimiento de infra tras un shared-secret en query string. Ya documentado en `DEBT_TECH.md` §1.

---

## 7. Riesgos y decisiones arquitectónicas a documentar explícitamente

1. **Modelo pool de un solo proceso (blast radius compartido).** Un event loop bloqueado o un OOM degrada **todas** las marcas. Documentar en un ADR, y no dar por hecho que "single task" es suficiente (H17, H4).
2. **Estado de sesión en memoria.** Hasta migrar a Redis (2.1), el sistema es efectivamente **single-instance**; escalar hoy rompería OAuth. Debe quedar escrito como restricción operativa (H4).
3. **Dependencia dura del backend de marca en la ruta caliente.** Sin caché ni circuit breaker (H12), la disponibilidad de Companion queda atada a la del backend de cada marca.
4. **Confianza en la configuración del bucket (no verificable en repo).** El código respeta bucket policies (no fuerza ACL ni SSE); la seguridad real depende de que los buckets sean privados, tengan SSE y política de cifrado obligatorio, y lectura vía CloudFront+OAC (H24). Debe verificarse y documentarse en infra.
5. **`allowLocalUrls`/`uploadUrls` amplios por defecto (H1/H2).** Decisión de conveniencia de dev que **no debe** llegar a prod sin restringir; documentar el porqué del valor por entorno.
6. **Secretos en env vars como blobs JSON (H14).** Aceptable a pequeña escala; documentar el punto de dolor (límite ECS, rotación) y el disparador para migrar a Secrets Manager.

---

## 8. Apéndice — Fuentes del benchmark de industria

Área 1 — Companion en producción:
- https://uppy.io/docs/companion/
- https://github.com/transloadit/uppy/blob/main/packages/@uppy/companion/KUBERNETES.md
- https://github.com/transloadit/uppy/issues/1845 · https://github.com/transloadit/uppy/issues/1159

Área 2 — Presigned/multipart S3:
- https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html
- https://aws.amazon.com/blogs/compute/securing-amazon-s3-presigned-urls-for-serverless-applications/
- https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/additional-guardrails.html
- https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/

Área 3 — Multi-tenancy / aislamiento:
- https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html
- https://aws.amazon.com/blogs/security/how-to-implement-saas-tenant-isolation-with-abac-and-aws-iam/
- https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/implement-saas-tenant-isolation-for-amazon-s3-by-using-an-aws-lambda-token-vending-machine.html
- https://developer.hashicorp.com/vault/tutorials/enterprise/namespaces

Área 4 — Observabilidad y operación:
- https://github.com/pinojs/pino
- https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html
- https://nodejs.org/api/async_context.html
- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html

Área 5 — Tooling TS / entrega:
- https://eslint.org/docs/latest/use/configure/migration-guide
- https://biomejs.dev/guides/migrate-eslint-prettier/
- https://vitest.dev/config/coverage
- https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql

Área 6 — Config y secretos:
- https://12factor.net/config
- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html
- https://aws.amazon.com/blogs/security/how-to-choose-the-right-aws-service-for-managing-secrets-and-configurations/

Documentos internos relacionados: `DEBT_TECH.md`, `docs/ROADMAPFuturo.md`, `docs/superpowers/specs/2026-04-29-cookie-only-cross-origin-auth-design.md`.
