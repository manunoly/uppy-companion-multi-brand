# Rediseño de `companion-platform-multi-brand`: alineación con el modelo de marcas de abeduls3 + endurecimiento para producción

> Spec de diseño · Fecha: 2026-07-02 · Rama: `feat/vitest-suite` (base)
> Autor: Claude (Opus 4.8) con investigación de subagentes · Estado: **revisado por Fable 5 + Sonnet 5 (ronda 1 aplicada)**
> Cliente principal del servidor: **abeduls3** (monorepo Entourage/ECS). Marca objetivo del MVP: **edo** (Entourage/edonext); **abe** (Abeduls/capsule) en la fase inmediatamente posterior (ver D5.b).
> Documentos relacionados: `docs/ROADMAP-AUDITORIA.md`, `DEBT_TECH.md`, `docs/ROADMAPFuturo.md`; en abeduls3: `packages/brands/*`, `apps/designer/lib/auth/brandResolver.ts`, `apps/node-socket/src/auth/resolvePartnerSocketIdentity.ts` + `resolveBrandBySocketHost.ts`, `apps/designer/services/brandImages/edoImageSource.ts`, `documentation/ADR-014-partner-realtime-same-site-cookie-forward.md`.

---

## 1. Contexto y objetivo

`companion-platform-multi-brand` es un servidor Express (Node ≥22, TS ESM NodeNext strict) que hospeda **una instancia aislada de `@uppy/companion` por marca** para subir archivos a S3. Su **cliente principal es abeduls3** (el editor/designer white-label), cuyo modelo de marcas está formalizado en `@package/brands`.

Hoy el Companion define su **propio** esquema (`BrandConfigJSON`: `auth.url`, `auth.cookieName`, `public.loginUrl`…), lee `<SLUG_UPPER_SNAKE>` con JSON, resuelve marcas por CSV `COMPANION_BRANDS` y monta cada marca bajo `/{brandId}`. Ese esquema **diverge** del contrato de abeduls3 y su validación de sesión (`GET auth.url`) no es el patrón endurecido `partner-whoami` que usa abeduls3 en su servicio Node standalone.

**Objetivo:** rediseñar el Companion para que (a) hable el mismo modelo de marca y autenticación que abeduls3, (b) incorpore las mejoras de la auditoría (seguridad, escalado, observabilidad, entrega), (c) quede listo para producción, empezando por **edo**. El proyecto **no está en producción**, así que se rediseña sin compatibilidad hacia atrás.

### 1.1 Criterios de éxito

1. Una marca se configura con **una sola variable** con la **misma forma** que abeduls3 (`EDO_BRAND_OVERRIDE={...}`), más las credenciales S3/OAuth como **variables de servicio** (Railway Variables en el deploy inicial; AWS Secrets Manager opcional a futuro).
2. El Companion **valida la sesión de un usuario de edo** reenviando la cookie del partner al `whoamiUrl`, con el endurecimiento de abeduls3 (SSRF gate, `redirect:'manual'`, timeout 5 s, cap 16 KB, breaker por marca, caché por `sha256(cookie)+slug`) **y** el enriquecimiento `edoId` (ver D5).
3. Las keys S3 quedan namespaciadas por marca (bucket por marca) y por usuario con el **`id` canónico** (para todas las marcas, edo incluido; el `edoId` es solo un extra para metadata/listado, **no** la key — SA1).
4. El servidor escala a ≥2 réplicas (sesión y estado en Redis, sin sticky sessions) y expone liveness + readiness con graceful shutdown por SIGTERM del orquestador (**Railway** en el deploy inicial).
5. Seguridad de plataforma: SSRF cerrado, rate limiting por marca, `helmet`+CSP+SRI, límite de tamaño, secretos fuera del blob (variables de servicio de Railway; SM opcional).
6. Entrega: linter+formatter, `build` como gate de CI, escaneo de dependencias/SAST/secretos, cobertura ≥ actual.
7. Un **smoke test** valida el flujo real contra el whoami de **stage** de edo antes de cerrar la entrega.

### 1.2 Fuera de alcance (esta spec)

- Escaneo antivirus (ClamAV) → Fase diferida.
- Extraer paquete npm compartido `@ecs/brands` → se define el camino (D1), no se implementa ahora.
- Rediseño tipado del bundle `uppyModal.ts` (`@ts-nocheck`, H21) → diferido (listado en §Fase 8 del plan).
- El campo `chrome` de `@package/brands` (UI del designer) **no aplica** al Companion.

---

## 2. Decisiones de integración (tomadas 2026-07-02) + verificaciones externas pendientes

Estos cuatro puntos se decidieron con el usuario tras verificar el código real de abeduls3. Lo que queda es **verificación externa** (con el equipo de edonext/infra), no diseño.

- **SA1 — Almacenamiento S3 de edo → el Companion firma con el `id` canónico (NO `edoId`), con un path SENCILLO.** La evidencia real (captura de `HandlePhotos.asp`: `entourage-uploads.s3.amazonaws.com/original/1004/…`) muestra que el S3 de edo se organiza por el **`id` canónico** (`1004`), no por `edoId` (`854569`, solo `member_id` de *listado*). **Decisión del usuario:** el Companion presigna él mismo con un **path simple y homogéneo** `{s3Prefix}original/{userId}/{yyyy}/{mm}/{dd}/{timestamp}/{filename}` (`userId = user.id` canónico), **sin** el segmento `UPID_{orderId}` del pipeline legacy de edonext. `edoId` deja de usarse para keys. ⚠️ **Verificación externa pendiente:** confirmar con edo que sus fotos se registran/consumen por la **key notificada** (vía `publicUploadUrl`), no por una convención de path rígida — así el path simple es válido; + bucket. El `assets.s3Prefix='brands/edo/'` del registro de abeduls3 **no** aplica (edo usa `original/…` directo).
- **SA2 — Host público del Companion → `companion.entourageyearbooks.com` (prod) / `companion.stage.entourageyearbooks.com` (stage).** Debe estar bajo `.entourageyearbooks.com` para recibir la cookie cross-apex (ADR-014); `companion.*` es consistente con `companion.abeduls.local` (abe) y el patrón `<servicio>.entourageyearbooks.com`. Entran en el registro como `companionHosts` (code-only). ⚠️ **Verificación externa:** provisión DNS/TLS de esos hosts (infra).
- **SA3 — Folders → conservar `folders.service`** con `public.foldersUrl?` opcional y degradación a `[]` + log. (El designer no consume folders del Companion hoy y edo solo usa `Facebook`/`Url`, pero se conserva por si se activa Dropbox/GoogleDrivePicker.)
- **SA4 — CORS → mantener el echo de `*.<apex>` (subdominios a cualquier profundidad), HTTPS-only en prod.** Se acepta cualquier origen `https://<...>.entourageyearbooks.com` con uno o más niveles de subdominio (`designer.entourageyearbooks.com`, `designer.stage.entourageyearbooks.com`, …) + `Allow-Credentials: true`. La regex actual de `corsForBrand` (`([a-z0-9-]+\.)+<rootDomain>`, `cors.ts:32-35`) ya lo soporta — **no se migra a orígenes exactos** (decisión explícita del usuario, más flexible que la recomendación literal de ADR-014 F4). ⚠️ **Verificación externa (smoke test):** que la cookie de stage sea `Domain=.entourageyearbooks.com` + `Secure` (la emite edonext; criterio bloqueante de ADR-014).

---

## 3. Estado actual vs destino (brechas)

| Aspecto | Companion hoy | Destino (abeduls3/industria) | Decisión |
|---|---|---|---|
| Contrato de marca | `BrandConfigJSON` propio + legacy | `@package/brands` `BrandConfig` (auth union, `assets.s3Prefix`, `imageSource.upload`) | D1, D2 |
| Config por env | `<SLUG_UPPER_SNAKE>`=JSON | `<SLUG>_BRAND_OVERRIDE` + registro base en código | D3 |
| Resolución de marca | CSV + montaje por path | Por `Host` (exact-match contra allowlist propio) + `BRAND_FORCE` | D4 |
| Auth | `GET auth.url` | `partner-whoami` endurecido + enriquecimiento edo | D5 |
| Identidad S3 | `req.user.id` | `id` canónico (todas las marcas; `edoId` **no** se usa para keys) | D6 |
| Sesión/estado | MemoryStore | Redis (sesión, caché whoami, breaker, rate-limit) | D7 |
| Secretos | Blob JSON | Variables de servicio (Railway); SM opcional | D8 |
| SSRF | `allowLocalUrls:true`, `uploadUrls:['*']`, sin validHosts | allowlist estricta + validHosts | D9 |
| Observabilidad | `console.*` | Pino + AsyncLocalStorage + readiness + shutdown | D10 |
| Entrega | typecheck+coverage | + build, lint, SAST, secretos | D11 |

Estado actual verificado: `brand.types.ts:47-165`, `brand.schema.ts:39-85`, `companion.factory.ts:126` (`allowLocalUrls:true`), `brand.service.ts:217` (`uploadUrls:['*']`), `server.ts:64-77` (sesión sin `store`), `auth.service.ts:52-86`, `s3Client.ts:53-93` (código muerto).

---

## 4. Decisiones de diseño

### D1 — Reimplementar el contrato compatible con `@package/brands`, con camino a paquete compartido
El Companion es un **repo separado**; no puede importar `@package/brands`. Se reimplementa el contrato con **nombres 1:1** para las partes compartidas (`slug`, `name`, `auth` union, `assets.s3Prefix`, plugins de upload) y se añaden las partes Companion-only (`s3`, `providers` OAuth, `secret`, `companionHosts`, `companionUrl`). **Camino futuro (Fase 8):** extraer `@ecs/brands` (npm privado) consumido por abeduls3 y Companion. **Aviso honesto:** el mecanismo de override de abeduls3 (`identity.ts`) sólo cubre el sub-objeto `auth` (+`realtime`/`chrome`); overridear campos no-`auth` es **lógica nueva** en el Companion, no un port 1:1 (ver D3).

### D2 — Modelo de configuración de marca

```ts
type BrandSlug = 'abe' | 'picaboo' | 'edo';

interface BrandResponseMapping { idField: string; emailField: string; nameField: string; imageField: string; }

type BrandAuthConfig =
  | { kind: 'capsule';
      signInUrl: string; signOutUrl?: string;
      whoamiUrl: string;                       // Companion-only: endpoint EXTERNO de capsule (ver D5.b)
      whoamiAllowedHosts: readonly string[];   // gate SSRF (capsule también, al ser standalone)
      sessionCookieName: string; responseMapping: BrandResponseMapping; }
  | { kind: 'partner-whoami';
      signInUrl: string; signOutUrl?: string;
      whoamiUrl: string; whoamiAllowedHosts: readonly string[];  // NO overridables
      sessionCookieName: string; responseMapping: BrandResponseMapping; };

type EdoUploadPlugin = 'Facebook' | 'Dropbox' | 'GooglePhotosPicker' | 'GoogleDrivePicker' | 'Url';

interface CompanionBrandConfig {
  slug: BrandSlug;
  name: string;
  domains: readonly string[];                  // hosts del designer/app (para CORS)
  companionHosts: readonly string[];           // hosts propios del Companion (resolución por Host) — code-only; [] = marca NO servible
  auth: BrandAuthConfig;
  assets: { s3Prefix: string };                // code-only, NO overridable; '' para edo (usa original/{id}/ directo)
  upload: { plugins: readonly EdoUploadPlugin[]; system: string; systemDetails: string };
  limits: { maxUploadBytes: number; allowedContentTypes?: readonly string[] };  // D14: tamaño/tipo por marca
  public?: { foldersUrl?: string };            // conservado (SA3): degradación a [] + log
  companionUrl: string;                        // origin público del Companion (OAuth redirect)
  secret: string;                              // COMPANION_SECRET
  s3: { bucket: string; region: string; accessKey?: string; secretKey?: string; useAccelerateEndpoint?: boolean };
  providers: { google?: {...}; dropbox?: {...}; /* … */ };
}

interface BrandUser {                          // canónico (idéntico a abeduls3) + extras edo
  id: string; email: string; displayName: string | null; imageUrl: string | null;
  edoId?: number;                              // poblado por enrichEdoUser (D5), sólo edo
}
```

**Nota `BrandResponseMapping`:** se mantiene idéntico a abeduls3 (4 campos). El `edoId` **no** sale de `responseMapping`/`normalizeBrandUser`; se extrae aparte (D5). **`upload`** es un aplanamiento de `imageSource.upload` de abeduls3 (que es `imageSource` nullable → `upload`); se documenta que este rename hace que la extracción a `@ecs/brands` (D1) **no** sea puramente mecánica. Validación: Zod (el Companion ya lo usa). Se **eliminan** los campos legacy.

**Mapeo viejo→nuevo:** `auth.url`→`auth.whoamiUrl`; `auth.cookieName`→`auth.sessionCookieName`; `public.loginUrl`→`auth.signInUrl`; nuevos: `auth.kind`, `auth.whoamiAllowedHosts`, `auth.responseMapping`, `auth.signOutUrl`, `assets.s3Prefix`, `companionHosts`, `upload.plugins`.

### D3 — `<SLUG>_BRAND_OVERRIDE` + registro base
- Registro base **en código** (deep-frozen) con valores de producción por marca (equivalente a `packages/brands/src/registry.ts`).
- Override `<SLUG>_BRAND_OVERRIDE` (JSON anidado), leído por proceso, **merge field-by-field con allowlist** replicando `identity.ts`:
  - **Overridable:** únicamente los campos **string de `auth`** existentes: `whoamiUrl`, `signInUrl`, `signOutUrl`, `sessionCookieName`.
  - **NUNCA overridable:** `kind`, `whoamiAllowedHosts` (SSRF gate), **`assets.s3Prefix`** (aislamiento por tenant), **`companionHosts`**, y todo `s3`/`providers` (secretos → variables de servicio del entorno, ver D8). Estos son **code-only**.
  - Validación por campo (token RFC ≤128 chars para cookie; `new URL()` https; revalidación de host contra `whoamiAllowedHosts`), protección prototype-pollution (`__proto__`/`constructor`/`prototype`), fail-safe al valor base.
  - **Diferencia con abeduls3:** el Companion **loguea** cada rechazo (`logger.warn({slug,field})`, sin el valor).
- **La misma `EDO_BRAND_OVERRIDE` que se fija en designer y node-socket se fija en el Companion** (requisito operativo, documentado en `.env.example`).

### D4 — Resolución de marca por `Host` (exact-match) + `BRAND_FORCE`
Se elige **match exacto** del `Host` normalizado (lowercase, sin puerto) contra un allowlist **explícito** `companionHosts` de cada marca — el patrón de `packages/brands/src/detect.ts:16-23` (`domains.includes(normalized)`), **no** el suffix-match de `resolveBrandBySocketHost.ts` (que abeduls3 marca como deuda `TECH_DEBT DES-024` por mapear cualquier `*.<apex>`).
- `BRAND_FORCE=<slug>` gana siempre (despliegue dedicado por marca / apex).
- **Host desconocido en producción → 404** (rechazo explícito). **Nunca** cae a `abe` por defecto (a diferencia de `resolveBrandBySocketHost`). En dev, sin match → default configurable.
- Los `companionHosts` (`companion.entourageyearbooks.com` + `companion.stage.…`) son distintos de `domains` (host del designer, `linkdesigner.…`). SA2 los fija.
- Aislamiento interno preservado: una instancia `@uppy/companion` por marca; se enruta por la marca resuelta del Host. `companionUrl` por marca es la fuente del `redirect_uri` (elimina el hack `/default/`).

### D5 — Autenticación endurecida (`partner-whoami` + enriquecimiento edo; `capsule`)

**a) partner-whoami (edo) — patrón base `resolvePartnerSocketIdentity.ts` + enriquecimiento del designer.** **El ORDEN de los pasos es una propiedad de seguridad, no cosmético** (fiel a `resolvePartnerSocketIdentity.ts:44-73`):
1. Extraer el **valor** de la cookie por `resolveEffectiveSessionCookieName` del header `Cookie`.
2. `resolveValidatedWhoamiTarget(brand)` (SSRF gate: https, sin credenciales, sin puerto no estándar, host **permitido por `whoamiAllowedHosts` vía suffix-match seguro**: `h === e || h.endsWith('.'+e)` — fiel a `identity.ts:9-14`; p.ej. con `['entourageyearbooks.com']` se permite `edonext-app.stage.entourageyearbooks.com` ✓ y se rechaza `evilentourageyearbooks.com` ✗ — **NO igualdad estricta**) → si falla, `misconfigured`, **nunca** hace fetch. (Vale para `partner-whoami` **y** `capsule`, ver D5.b.)
3. **`const cookieHeader = buildCookieHeader(name, value); if (cookieHeader === null) → `unauthenticated`.** Este null-check va **ANTES** del breaker: una cookie malformada (`;`/CRLF) **no debe tocar el breaker**, si no un atacante no autenticado podría abrirlo para **todos** los usuarios de la marca spammeando cookies basura (DoS de auth). Fiel a `resolvePartnerSocketIdentity.ts:54-58`.
4. `breaker.isOpen(slug)` → si abierto, `unavailable` (fail-fast, **antes** de la caché).
5. Caché Redis `companion-whoami:{slug}:{sha256(cookie)}` (namespace **propio**, no colisiona con `socket-whoami:` de node-socket), TTL **45 s fijo**, guarda el **`BrandUser` completo serializado** (no sólo el id — necesario para conservar `edoId`/`email` en cache-hit).
6. `fetch(whoamiUrl,{ method:'GET', headers:{ Cookie: cookieHeader }, redirect:'manual', signal: AbortSignal.timeout(5000) })`. (`cache:'no-store'` es opcional/defensivo: el designer lo usa, node-socket no; se trata como no-op benigno en S2S y se cubre con un test que no dependa de él.)
7. Interpretación de estado (fiel a `resolvePartnerSocketIdentity.ts:89-102`): `status===0`/`opaqueredirect`/`3xx` → `unavailable`+`recordFailure`; `401` → `unauthenticated`+`recordSuccess`; `!ok` (5xx y 4xx≠401) → `unavailable`+`recordFailure`; `200` → seguir.
8. Body cap **16 KB** por streaming (no confiar en `Content-Length`).
9. `normalizeBrandUser(responseMapping, json)` → `{id,email,displayName,imageUrl}` (valida `id` `/^[A-Za-z0-9_-]{1,64}$/`, `email` con `@`). **Luego, sólo si `slug==='edo'`, `enrichEdoUser(user, json)`** (portado de `apps/designer/lib/auth/brandResolver.ts`: `readEdoExtras` `:161-181` **+** `parseEdoEmail` que separa el prefijo `<username>::<email>`, `enrichEdoUser` `:194-199`): lee `raw.edo_id` → `user.edoId` (number) y normaliza el email. Cachear el user enriquecido. **El enriquecimiento se dispara por `slug==='edo'`, no por `kind`** (picaboo también es `partner-whoami` pero no tiene `edoId`).

**b) capsule (abe) — MVP posterior a edo:**
La variante `capsule` de abeduls3 (`types.ts:71-77`) **no tiene** URL de endpoint (el designer usa un `getInternalBaseUrl` co-ubicado, sin breaker); node-socket **rechaza** capsule. Como el Companion es standalone, `capsule` en el Companion **añade** `whoamiUrl` + `whoamiAllowedHosts` (endpoint EXTERNO de capsule con su gate SSRF) y usa el **mismo** flujo endurecido de (a) salvo el enriquecimiento edo. Identidad S3 = `user.id` canónico (CUID2). **edo es el camino primario probado del MVP; abe se habilita justo después con su endpoint externo confirmado.**
> **Al portar `identity.ts`, `resolveValidatedWhoamiTarget` debe GENERALIZARSE:** el original de abeduls3 (`identity.ts:152-159`) devuelve `{ok:false}` cuando `kind!=='partner-whoami'`; en el Companion ambas variantes del contrato llevan `whoamiUrl`+`whoamiAllowedHosts` (D2), así que la función debe validar el target **también para `capsule`**, no rechazarlo por `kind`. De lo contrario abe/capsule nunca haría fetch (`misconfigured` permanente).

**c) Circuit breaker — DISEÑO NUEVO (no port):** abeduls3 usa un breaker **en memoria** (closures) en node-socket; su `circuit-breaker.ts` Redis es de otro subsistema. El breaker del Companion es **nuevo**: Redis-backed para consistencia entre réplicas, con `INCR` atómico del contador, `recordSuccess` **borra** el contador, `open` con `EX 30`, y una **sonda half-open** (una sola réplica prueba al expirar). Se reconoce el riesgo de thundering-herd y se cubre con tests de concurrencia (no se trata como port low-risk).

**Modelo de cookie:** el Companion **nunca** emite ni verifica la cookie del partner; sólo la reenvía. Su `express-session` (estado OAuth) es independiente y vive en Redis (D7), con `cookie.path='/'` y nombre derivado de la marca (no del path, ver D7).

### D6 — Generación de keys S3 (decisión SA1: `id` canónico, esquema de edonext, aislamiento por bucket)
- **Identificador de usuario = `user.id` canónico para TODAS las marcas** (edo incluido). Guard: `if (!user.id) → 401`. **El `edoId` NO se usa para keys** (es solo el `member_id` de *listado* del designer; el S3 real de edo se indexa por el `id` canónico — evidencia SA1). `enrichEdoUser` se mantiene (email normalizado y `edoId` disponible para metadata/logs), pero el key-builder no depende de él.
- **Esquema de key = path sencillo y homogéneo (igual para todas las marcas):** `{s3Prefix}original/{userId}/{YYYY}/{M}/{D}/{timestamp}/{filename}`, con `userId = user.id` (canónico, homogeneizado por `normalizeBrandUser`). **Sin `UPID_{orderId}`** (decisión del usuario: path simple con el id del usuario). Como el `id` es homogéneo, `buildS3Key` es **una sola función independiente de la marca** (no ramifica por slug/kind).
- **Aislamiento por marca = por BUCKET, no por prefijo `brands/{slug}/`.** Cada marca tiene su propio bucket S3 (edo → `entourage-uploads`); el esquema `original/{id}/...` es común. `brand.assets.s3Prefix` queda **opcional** (por defecto vacío para edo, que usa `original/...` directo; puede prefijar para marcas que el Companion controle a su gusto). Documentar que `assets.s3Prefix='brands/edo/'` del registro de abeduls3 es aspiracional y **no** aplica al S3 real de edonext.
- Segunda capa BOLA `sendIfKeyNotOwned` valida el prefijo por-usuario `{s3Prefix}original/{id}/`.
- **Verificación externa pendiente (SA1):** que edonext registre/consuma las fotos por la **key notificada** (`publicUploadUrl`), no por convención de path; + bucket. Cubierto por el smoke test (Task 7.2).

### D7 — Sesión y estado en Redis
`express-session` con `connect-redis` (cierra H4). Redis aloja sesión OAuth, caché whoami (D5), estado del breaker (D5) y contadores de rate-limit (D13). `COMPANION_SECRET` idéntico entre réplicas; sin sticky sessions; `redisPubSubScope` para el WS de Companion. **Cookie de sesión:** al pasar de montaje por path a resolución por Host, `cookie.path` pasa de `/${brandId}` a `/` y el `name` es **único y estático** (`companion.sid`), **no** por-slug: `express-session` se configura una sola vez (middleware-factory) y `brand` sólo existe per-request, así que un `name` dinámico ni es implementable ni es necesario — cada marca vive en un `companionHost` distinto (D4), por lo que el navegador ya aísla la cookie por host. (Corrige el acoplamiento actual `server.ts:65,71` sin reintroducir dependencia de la marca en tiempo de configuración.)

### D8 — Secretos fuera del blob (Railway Variables en el deploy inicial; Secrets Manager opcional)
El **deploy inicial es Railway**, no ECS/AWS. Por tanto:
- Credenciales S3/OAuth por marca se proveen como **variables de servicio de Railway** (marcadas *sealed*/secretas), inyectadas al proceso como env vars — **no** hay `valueFrom` de ECS ni task execution role. El override `<SLUG>_BRAND_OVERRIDE` sólo lleva campos no-secretos.
- **Importante (Railway ≠ AWS):** en Railway **no hay IAM role de instancia**, así que el `S3Client` necesita **access key / secret key explícitas** (variables de Railway). El fallback a la Default Credential Provider Chain (IAM role) **sólo aplica si se migra a AWS/ECS**.
- Abstracción `loadBrandSecrets(slug)` con `SECRETS_SOURCE`: **`env` (Railway, por defecto)** lee de variables de entorno; **`aws` (opcional)** lee de AWS Secrets Manager (`GetSecretValueCommand`) para cuando/si se migre a AWS. Fail-fast si falta un secreto requerido.
- El límite de 64 KB de la task def de ECS **no aplica** a Railway; el argumento contra el blob JSON sigue válido por higiene/rotación/auditoría (12-factor), no por ese límite.

### D9 — Cerrar SSRF por entorno
`allowLocalUrls = env.protocol === 'http'` (sólo dev). `uploadUrls` deja de ser `['*']`: se deriva de `s3.bucket`/`companionUrl`/`domains`. Se configuran `COMPANION_CLIENT_ORIGINS` y **`validHosts`** (allowlist de `redirect_uri` de Companion) — **con test dedicado** (cierra H1, H2, **H7**).

### D10 — Observabilidad
Pino + `pino-http` reemplaza `console.*` (H9); `requestId`/`brand`/`userId` por AsyncLocalStorage (H10). `GET /api/readyz` (readiness: Redis + S3 con timeout corto) separado de `/api/healthz` (liveness) (H11). Graceful shutdown: `server.close()` + timeout de seguridad + 503 en readiness durante drenaje + cierre del WS de Companion y Redis, alineado con el ciclo SIGTERM→drenaje del orquestador (**Railway** inicialmente; si se migra a ECS, con `deregistration_delay`) (H19). OTel diferido.

### D11 — Entrega y calidad
CI añade `pnpm build` (H3/H5), `pnpm lint` (Biome, H15), Dependabot + CodeQL + gitleaks (H16). `.dockerignore` deja de excluir `scripts/` (bug real H3). `USER node` (H20). Se borra el código muerto de `s3Client.ts` (H18) y los ficheros sueltos de la raíz (H22).

### D12 — Documentar el modelo de tenancy (ADR **antes** del código)
Un ADR (redactado **al inicio**, no post-hoc): modelo **pool** por defecto (varias marcas por proceso, resueltas por Host) con aislamiento reforzado (Redis, secretos gestionados, STS en Fase 8); puerta de escape a **bridge/silo** vía `BRAND_FORCE` (un servicio/deploy por marca) para alto volumen/compliance. Cierra H17.

### D13 — Rate limiting por marca
`express-rate-limit` + `rate-limit-redis` (store Redis) en `/uppy` y `/api/*`, clave por **marca + usuario/IP**. Cierra H8. (Ver wiring `sendCommand` en el plan.)

### D14 — Límite de tamaño en la firma S3
Se valida el `Content-Length` **declarado** antes de firmar (PUT por query). **Cierra H13 sólo parcialmente** (declarativo): un cliente puede mentir el tamaño real; el enforcement server-side real requiere **presigned POST** con `content-length-range`, diferido a Fase 8. Límites configurables por marca. `expiresIn` ≤ 300 s.

---

## 5. Registro base (ejemplo `edo`, producción) y override de stage

```ts
edo: {
  slug: 'edo', name: 'Entourage',
  domains: ['linkdesigner.entourageyearbooks.com'],           // host del designer (para CORS, uno o más niveles)
  companionHosts: ['companion.entourageyearbooks.com', 'companion.stage.entourageyearbooks.com'], // SA2: hosts propios del Companion (prod+stage) — code-only, resolución por Host
  auth: {
    kind: 'partner-whoami',
    signInUrl: 'https://edonext.entourageyearbooks.com/login',
    signOutUrl: 'https://edonext-app.entourageyearbooks.com/logout',
    whoamiUrl: 'https://edonext-app.entourageyearbooks.com/api/user',
    whoamiAllowedHosts: ['entourageyearbooks.com'],            // NO overridable
    sessionCookieName: 'auth_session',
    responseMapping: { idField:'id', emailField:'email', nameField:'name', imageField:'profile_photo_url' },
  },
  assets: { s3Prefix: '' },                                     // SA1: edo usa 'original/{id}/...' directo (sin brands/edo/)
  upload: { plugins:['Facebook','Url'], system:'ENTOURAGE', systemDetails:'DESIGNER' },
  limits: { maxUploadBytes: 50 * 1024 * 1024 },                 // D14: ej. 50 MB (ajustar al límite real de edo)
  companionUrl: 'https://companion.entourageyearbooks.com',
  secret: '<COMPANION_SECRET>', s3: { bucket: 'entourage-uploads', region: 'us-east-1' /* creds: variables de Railway (o SM) */ }, providers: { /* variables de Railway */ },
}
```

Override de stage (misma variable que en designer/node-socket; `companionHosts` NO se overridea — se fija otro registro/despliegue por entorno o se añaden los hosts de stage al `companionHosts` base):
```
BRAND_FORCE=edo
EDO_BRAND_OVERRIDE={"auth":{"sessionCookieName":"auth_session_stage","whoamiUrl":"https://edonext-app.stage.entourageyearbooks.com/api/user","signInUrl":"https://edonext.stage.entourageyearbooks.com/login","signOutUrl":"https://edonext-app.stage.entourageyearbooks.com/logout"}}
```
> Nota: `companionHosts` incluye prod **y** stage (`companion.entourageyearbooks.com` + `companion.stage.entourageyearbooks.com`) en el registro base, porque el override **no** puede tocar `companionHosts` (code-only, D3).

---

## 6. Flujo de request (subida edo)

1. Browser (designer edo) → `fetch` a `https://companion.stage.entourageyearbooks.com/api/uppy/sign-s3`, `credentials:'include'` → cookie `auth_session_stage` (Domain cross-apex `.entourageyearbooks.com`).
2. Edge de Railway (TLS terminado por el proxy de Railway) → réplica. `pino-http` abre contexto (`requestId`). `resolveBrandByHost(companion.stage.entourageyearbooks.com)` → `edo` (o `BRAND_FORCE`). Host desconocido en prod → 404.
3. `SessionResolver` (orden de seguridad D5.a): extraer cookie → `resolveValidatedWhoamiTarget` (host ∈ `entourageyearbooks.com` ✓) → `buildCookieHeader` (null → `unauthenticated`, sin tocar breaker) → `breaker.isOpen('edo')`? no → caché `companion-whoami:edo:sha256`. Miss → `GET .../api/user` (`Cookie:`, `redirect:'manual'`, 5 s, 16 KB). `200` → `normalizeBrandUser` + `enrichEdoUser` → `{id:'1004', edoId:854569, email…}`. Cachea user completo 45 s.
4. `requireAuth` garantiza `req.user`. Key-builder (SA1, **id canónico homogéneo**): `original/1004/2026/7/2/<ts>/<file>` en bucket `entourage-uploads` (path sencillo, sin `UPID_`).
5. `signS3` firma PUT (SigV4, 300 s) validando `Content-Length` ≤ límite. `sendIfKeyNotOwned` valida el prefijo `original/1004/`.
6. CORS `corsForBrand` (echo de cualquier `https://<...>.entourageyearbooks.com` — 1+ niveles de subdominio — con `Allow-Credentials` + `Vary`, HTTPS-only en prod).

`401`→401. `5xx`/timeout/3xx→503 (`unavailable`); breaker abre tras 3 fallos.

> **CORS (decisión SA4):** se **mantiene** el echo de `*.<apex>` de `corsForBrand` (acepta subdominios a cualquier profundidad: `designer.entourageyearbooks.com`, `designer.stage.entourageyearbooks.com`, …), en vez de migrar a orígenes exactos como sugiere ADR-014 F4. Es una divergencia **consciente y aceptada** por su flexibilidad; el riesgo es acotado (credenciado, mismo apex, HTTPS-only en prod).

---

## 7. Puntos específicos

- **7.1 Plugins:** `upload.plugins` (tipado, de `imageSource.upload`) reemplaza `enabledPlugins` (CSV). `uppy.routes.getEnabledPlugins` se reescribe para derivar de esta lista.
- **7.2 `uppy.routes.ts`:** se **reescribe** (hoy importa `authenticate` de `auth.service`, usa `auth.url`/`public.*` legacy y **re-autentica** ignorando `req.user` — H12/Q10). Nuevo: usa `req.user` de `attachUser` (sin doble llamada), nuevos campos (`auth.signInUrl`), plugins tipados.
- **7.3 CORS:** `corsForBrand` se mantiene (HTTPS-only prod, echo origin, `Allow-Credentials`), alimentado por `domains` del registro; ver nota ADR-014 en §6.
- **7.4 Folders (SA3):** por defecto se **conserva** `folders.service` con `public.foldersUrl?` en el tipo y degradación a `[]` + log; si SA3 dice que el designer ya no lo usa, se **elimina** (el plan tiene un task condicional para ambos caminos). Esta spec **no** afirma que el punto esté resuelto: depende de SA3.
- **7.5 test-utils:** `fixtures.ts` (`makeBrand`) y `http.ts` (`createTestApp`) se **reescriben** al nuevo `Brand`/`assembleApp` (Host-based, Redis) antes de los tests de integración.

---

## 8. Testing

- **Unit:** `identity` (merge, prototype-pollution, tipos, longitud, host allowlist — portar `packages/brands/tests/identity.test.ts`); `detect` (exact-match, `BRAND_FORCE`, 404 en host desconocido); `session-resolver` (200/401/3xx/status0/4xx/5xx/timeout/16KB, breaker order, cache full-user hit, **enrichEdoUser puebla `edoId`**); `whoami-breaker` (3→open, half-open, clear on success, concurrencia); `s3.key-builder` (**id canónico** para todas las marcas, path `original/{id}/{fecha}/{ts}/{file}` **sin UPID**, **401 si falta `user.id`**, función única sin ramificar por marca); `companion.factory` (allowLocalUrls por entorno, `validHosts`, uploadUrls derivado).
- **Integración:** app ensamblada con `createTestApp` **reescrito**, `@uppy/companion`+S3 (`aws-sdk-client-mock`)+Redis (`ioredis-mock`)+whoami mockeados. Flujo completo §6 para edo (y abe cuando se habilite).
- **Smoke (SA1/SA4):** `verify-brand-config`/script que ejecuta el whoami real de **stage** con una cookie de prueba y valida `200` + `id` canónico (con `edoId` como extra), e imprime la key S3 que se generaría para contrastar el esquema con edo.
- **Contrato:** fixture con el `EDO_BRAND_OVERRIDE` real; test de que el registro base + override parsea.
- Cobertura ≥ 70/60/70/70; cerrar huecos de auditoría (`s3Client`, `companion.factory`).
- **Nota:** `ioredis-mock` es señal más débil que Redis real para lógica de seguridad (breaker/caché); riesgo aceptado (testcontainers como mejora futura).

---

## 9. Migración
Reemplazo directo (no hay producción): registro/identity/detect nuevos → cutover **atómico** de `brand.types`+consumidores (incl. `uppy.routes`, `folders`, `fixtures`, key-builder) → auth → key-builder → server Host-based → carga de secretos (Railway env) → docs. Sin compatibilidad con `<SLUG_UPPER_SNAKE>` ni legacy. (El plan ordena esto para que cada fase deje `typecheck` **verde**.)

## 10. Compliance (datos potencialmente de menores)
Aislamiento por tenant **por bucket S3 por marca** (edo → `entourage-uploads`) + prefijo por usuario `original/{id}/` (D6); STS scoped en Fase 8. Auditoría (variables de servicio + logs de Railway; CloudTrail sólo si se usa SM/AWS — D8; Pino+requestId D10). Retención/borrado: lifecycle S3 por marca (infra, Fase 8). Cifrado SSE + buckets privados + CloudFront/OAC: infra (H24, verificar). Aislamiento por Host evita fuga cross-marca.

## 11. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Path simple del Companion ≠ esquema legacy de edonext (SA1) | Válido si edonext registra por key notificada (`publicUploadUrl`), no por convención de path rígida; confirmar con edo (smoke test) |
| Reimplementación diverge de `@package/brands` | Nombres 1:1 + tests portados + camino a `@ecs/brands` |
| Cookie cross-apex mal configurada (SA2/SA4) | ADR-014 como prerrequisito + smoke test stage |
| Breaker Redis (diseño nuevo) con carreras | `INCR` atómico + half-open + tests de concurrencia |
| Redis SPOF | ElastiCache multi-AZ; readiness 503 si cae |
| whoami lento/caído | Breaker+caché+`unavailable≠unauthenticated` |
| `typecheck` roto entre tareas | Cutover atómico (plan) |

## 12. Referencias
- Auditoría: `docs/ROADMAP-AUDITORIA.md` (H1–H24), `DEBT_TECH.md`, `docs/ROADMAPFuturo.md`.
- abeduls3: `packages/brands/src/{types,registry,identity,detect,slugs}.ts`; `apps/node-socket/src/auth/{resolvePartnerSocketIdentity,resolveBrandBySocketHost}.ts` (DES-024); `apps/node-socket/src/persistence/circuit-breaker.ts`; **`apps/designer/lib/auth/brandResolver.ts:161-181` (`readEdoExtras`/`enrichEdoUser`)**; `apps/designer/services/brandImages/edoImageSource.ts:26-31` (`requireMemberId`); `documentation/ADR-014-partner-realtime-same-site-cookie-forward.md`; `docs/superpowers/specs/2026-06-16-brand-config-env-override.md`.
- Industria: Uppy Companion (≥2 réplicas + Redis), AWS Well-Architected SaaS Lens (pool/bridge, TVM/ABAC), OWASP API1:2023, 12-Factor III, Pino, Biome. URLs en `docs/ROADMAP-AUDITORIA.md` §8.
```
