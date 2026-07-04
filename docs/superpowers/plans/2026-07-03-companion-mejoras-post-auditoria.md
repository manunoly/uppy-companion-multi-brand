# Mejoras post-auditoría (Fable 5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar las mejoras **accionables en el repo** de la auditoría de seguimiento (`docs/ROADMAP-AUDITORIA-2.md`): gap de CSP para el Google Picker (N1/Q5), gate SSRF en `folders.service` (N5/C3), cifrado en reposo forzado en el multipart create (Q6, porción de código), y el arreglo del build de imagen Docker + job de CI que lo valide (C1).

**Architecture:** El servidor Express monta una instancia `@uppy/companion` por marca resuelta por Host. Estas tareas tocan cuatro puntos aislados y de bajo riesgo: la construcción de directivas CSP por marca (`core/csp.ts` + cableado en `server.ts`), el fetch de folders (`modules/folders/folders.service.ts`), el firmado/creación S3 (`modules/companion/s3/s3.controller.ts`), y la cadena de entrega (`package.json`/`Dockerfile`/`.github/workflows/ci.yml`). Ninguna altera el contrato de seguridad ni las decisiones SA1–SA4.

**Tech Stack:** Node ≥22, pnpm 10.32.1, TypeScript ESM NodeNext (strict), Express 4, helmet 8, Zod 4, Vitest 4 + aws-sdk-client-mock + supertest, Biome 2, Docker (node:22-alpine), GitHub Actions.

## Global Constraints

- **Package manager:** pnpm (Node ≥22). Correr `pnpm install` una vez antes de empezar.
- **ESM NodeNext:** todo import interno lleva extensión `.js` aunque el fuente sea `.ts` (p.ej. `from './csp.js'`).
- **Strict + noUnusedLocals/Parameters:** no dejar imports/variables sin usar.
- **Logging:** nunca `console.*` en `src/**`; usar `logger` de `src/lib/logger.ts` (silenciado bajo Vitest).
- **Gates CI (en orden):** `pnpm lint` → `pnpm typecheck` → `pnpm build` → `pnpm test:coverage`. Los cuatro deben quedar verdes. Coverage no debe bajar de 70/60/70/70.
- **NO revertir** `pnpm build` al `tsconfig.json` raíz (usa `tsconfig.build.json`, que excluye tests).
- **Decisiones cerradas (no relitigar):** SA1 (S3 id canónico, path simple, aislamiento por bucket), SA2 (hosts Companion), SA3 (folders con degradación a `[]`), SA4 (CORS echo `*.<apex>`), infra Railway. Estas tareas son compatibles con todas ellas.
- **Verificar el árbol de tests tras cada tarea** con el subconjunto indicado y, al cerrar, con `pnpm test` completo.

---

### Task 1: CSP `script-src` incluye el loader del Google Picker (N1 / Q5)

**Problema:** `core/csp.ts` añade orígenes Google a `connect-src`/`frame-src`/`img-src` cuando el picker está activo, pero `script-src` (cableado inline en `server.ts:310-315`) es fijo y **no** incluye `https://apis.google.com`, el origen del que Google carga su loader del Picker. Latente hoy (edo usa solo `Facebook`/`Url`) pero rompería el Picker si cualquier marca lo habilita.

**Files:**
- Modify: `src/core/csp.ts` (añadir `buildScriptSrc`)
- Modify: `src/server.ts:310-315` (usar `buildScriptSrc` para la directiva `script-src`)
- Test: `src/core/csp.test.ts`

**Interfaces:**
- Produces: `buildScriptSrc(brand: Brand | undefined, nonce: string): string` — devuelve la directiva `script-src` completa (space-joined): `'self'` + `'nonce-<nonce>'` + `https://releases.transloadit.com` + `https://cdnjs.cloudflare.com` + (`https://apis.google.com` si `usesGooglePicker(brand)`).
- Consumes: la privada `usesGooglePicker(brand)` ya existente en `csp.ts`.

- [ ] **Step 1: Escribir el test que falla**

En `src/core/csp.test.ts`, añadir el import y el bloque `describe`:

```ts
// en el import existente de './csp.js', añadir buildScriptSrc:
import { buildConnectSrc, buildFrameAncestors, buildFrameSrc, buildImgSrc, buildScriptSrc } from './csp.js';
```

```ts
describe('buildScriptSrc', () => {
    it("incluye 'self', el nonce por-request y los CDNs base, sin Google por defecto", () => {
        const brand = makeBrand({ upload: { plugins: ['Url'], system: 's', systemDetails: 'd' } });
        const src = buildScriptSrc(brand, 'abc123');
        expect(src).toContain("'self'");
        expect(src).toContain("'nonce-abc123'");
        expect(src).toContain('https://releases.transloadit.com');
        expect(src).toContain('https://cdnjs.cloudflare.com');
        expect(src).not.toContain('apis.google.com');
    });

    it('añade https://apis.google.com solo cuando el picker de Google está habilitado', () => {
        const withPicker = makeBrand({ upload: { plugins: ['GoogleDrivePicker'], system: 's', systemDetails: 'd' } });
        expect(buildScriptSrc(withPicker, 'n')).toContain('https://apis.google.com');
    });

    it("usa la base segura sin Google cuando no hay marca resuelta (rutas globales)", () => {
        const src = buildScriptSrc(undefined, 'n');
        expect(src).toContain("'self'");
        expect(src).not.toContain('apis.google.com');
    });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test src/core/csp.test.ts`
Expected: FAIL — `buildScriptSrc is not a function` / no exportada.

- [ ] **Step 3: Implementar `buildScriptSrc` en `src/core/csp.ts`**

Añadir la constante junto a las otras `GOOGLE_*` (tras `csp.ts:45`):

```ts
const GOOGLE_SCRIPT_ORIGINS = ['https://apis.google.com'];
```

Añadir la función exportada (p.ej. tras `buildImgSrc`):

```ts
/**
 * `script-src`: same-origin + el nonce por-request de la página /uppy + los
 * CDNs de Uppy (transloadit) y SweetAlert2 (cdnjs) + el loader de Google APIs
 * (`apis.google.com`) cuando la marca habilita el Drive/Photos Picker. El
 * nonce se pasa desde `res.locals.cspNonce` (server.ts) porque helmet resuelve
 * esta directiva por-request.
 */
export const buildScriptSrc = (brand: Brand | undefined, nonce: string): string => {
    const origins = [
        "'self'",
        `'nonce-${nonce}'`,
        'https://releases.transloadit.com',
        'https://cdnjs.cloudflare.com',
    ];
    if (brand && usesGooglePicker(brand)) {
        origins.push(...GOOGLE_SCRIPT_ORIGINS);
    }
    return origins.join(' ');
};
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm test src/core/csp.test.ts`
Expected: PASS.

- [ ] **Step 5: Cablear `buildScriptSrc` en `src/server.ts`**

En el import de csp (buscar `buildConnectSrc` en `server.ts`), añadir `buildScriptSrc`. Luego reemplazar el array estático de `script-src` (`server.ts:310-315`) por la forma funcional (misma firma `(req, res)` que ya usa el nonce inline):

```ts
                'script-src': [
                    (req: IncomingMessage, res: ServerResponse) =>
                        buildScriptSrc(brandForCsp(req), (res as unknown as express.Response).locals.cspNonce),
                ],
```

- [ ] **Step 6: typecheck + build + test de integración de CSP**

Run: `pnpm typecheck && pnpm build && pnpm test src/server.integration.test.ts src/core/csp.test.ts`
Expected: PASS (el árbol de integración carga `/uppy` con la CSP; verificar que no rompe el header). Si algún test de integración asevera el `script-src` textual, actualizarlo para reflejar que ahora se construye por marca.

- [ ] **Step 7: Commit**

```bash
git add src/core/csp.ts src/core/csp.test.ts src/server.ts
git commit -m "fix(csp): incluir apis.google.com en script-src cuando el Google Picker está activo (N1)"
```

---

### Task 2: `folders.service` valida `foldersUrl` por el SSRF gate (N5 / C3)

**Problema:** `fetchFolders` reenvía la cookie de sesión a `brand.public.foldersUrl` sin pasarla por el gate SSRF (`validateWhoamiUrl`/allowlist), a diferencia de whoami. `foldersUrl` es code-only y hoy ningún brand servable lo fija, pero si se añadiera uno, el fetch saltaría el allowlist. Enrutarlo por el mismo gate cierra el hueco latente.

**Files:**
- Modify: `src/modules/folders/folders.service.ts`
- Test: `src/modules/folders/folders.service.test.ts`

**Interfaces:**
- Consumes: `validateWhoamiUrl(raw: string, allowedHosts: readonly string[]): { ok: true; url: URL } | { ok: false; reason: string }` (ya exportada en `modules/brand/identity.ts`). Se valida `foldersUrl` contra `brand.auth.whoamiAllowedHosts` (el apex de confianza de la marca).

- [ ] **Step 1: Escribir el test que falla (rechazo off-allowlist)**

En `src/modules/folders/folders.service.test.ts`, añadir:

```ts
it('returns [] y nunca llama fetch cuando foldersUrl está fuera del allowlist SSRF', async () => {
    const brand = makeBrand({
        public: { foldersUrl: 'https://folders.evil.com/api/folders' }, // no está bajo test.example.com
    });
    const folders = await fetchFolders('tok', brand);
    expect(folders).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test src/modules/folders/folders.service.test.ts`
Expected: FAIL — hoy `fetch` SÍ se llama contra `folders.evil.com` (no hay gate).

- [ ] **Step 3: Añadir el gate en `folders.service.ts`**

Añadir el import:

```ts
import { buildCookieHeader, validateWhoamiUrl } from '../brand/identity.js';
```

Insertar el gate justo tras el chequeo de `foldersUrl` ausente y ANTES de construir la cookie (para no reenviar credenciales a un destino no validado):

```ts
    if (!foldersUrl) {
        return [];
    }

    // N5: validar foldersUrl por el mismo gate SSRF que whoami (https, sin
    // credenciales/puerto no-default, host bajo el apex de confianza de la
    // marca) ANTES de reenviar la cookie de sesión — foldersUrl es code-only
    // hoy, pero esto impide reintroducir un fetch sin allowlist.
    const target = validateWhoamiUrl(foldersUrl, brand.auth.whoamiAllowedHosts);
    if (!target.ok) {
        logger.warn({ brand: brand.slug, reason: target.reason }, '[folders] foldersUrl rejected by SSRF gate');
        return [];
    }
```

Y usar `target.url` en el `fetch` (en vez de `foldersUrl`):

```ts
        const response = await fetch(target.url, {
```

- [ ] **Step 4: Ajustar el test existente que usaba un host off-allowlist**

El test `'fetches the configured absolute foldersUrl as-is'` (`folders.service.test.ts`, ~línea 100) usa `foldersUrl: 'https://x.example.com/api/folders'`, cuyo host `x.example.com` NO está bajo el apex por defecto `test.example.com` → ahora sería rechazado. Cambiarlo a un host bajo el apex permitido y ajustar la aserción (fetch recibe una URL o `URL`; comparar por `.toString()`):

```ts
    it('fetches the configured absolute foldersUrl as-is', async () => {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: [] }),
        });
        await fetchFolders('t', makeBrand({
            public: { foldersUrl: 'https://x.test.example.com/api/folders' },
        }));
        const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(String(call[0])).toBe('https://x.test.example.com/api/folders');
    });
```

> Nota: los demás tests de folders usan el `foldersUrl` por defecto de `makeBrand` (`https://app.test.example.com/api/folders`), que SÍ está bajo `test.example.com` y pasan el gate sin cambios.

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `pnpm test src/modules/folders/folders.service.test.ts`
Expected: PASS (todos, incluido el nuevo y el ajustado).

- [ ] **Step 6: typecheck + commit**

Run: `pnpm typecheck`
Expected: limpio.

```bash
git add src/modules/folders/folders.service.ts src/modules/folders/folders.service.test.ts
git commit -m "fix(folders): validar foldersUrl por el gate SSRF antes de reenviar la cookie (N5)"
```

---

### Task 3: Forzar cifrado en reposo (SSE-S3) en el multipart create (Q6, porción de código)

**Problema:** El código no fuerza `ServerSideEncryption` (H24/N9). En el flujo multipart, la creación se ejecuta **server-side** (`brand.s3.client.send(CreateMultipartUploadCommand)`), así que añadir `ServerSideEncryption: 'AES256'` ahí es limpio (todas las partes heredan el cifrado de la creación) y no acopla al cliente.

**Alcance explícito (por qué NO se toca el PUT simple ni las partes):** `signS3` (PutObject) y `signPart` (UploadPart) devuelven **URLs presignadas** que el navegador ejecuta; añadir `ServerSideEncryption` ahí exigiría que `uppyModal.ts` (browser, H21) enviara el header `x-amz-server-side-encryption` coincidente o la firma no cuadraría — eso pertenece a la migración a presigned POST (M1). El control autoritativo del PUT simple es el **cifrado por defecto del bucket** (infra, Q6/N9). Este task es defensa en profundidad para la ruta multipart (archivos grandes), sin regresión posible.

**Files:**
- Modify: `src/modules/companion/s3/s3.controller.ts:198-203` (`CreateMultipartUploadCommand`)
- Test: `src/modules/companion/s3/s3.controller.test.ts`

- [ ] **Step 1: Escribir el test que falla**

En `src/modules/companion/s3/s3.controller.test.ts`, añadir imports y un test que ejerza `createMultipartUpload` con el `S3Client` mockeado, y asevere que la orden lleva `ServerSideEncryption: 'AES256'`:

```ts
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, CreateMultipartUploadCommand } from '@aws-sdk/client-s3';
import { createMultipartUpload } from './s3.controller.js';
import { makeAppRequest, makeBrand, makeUser } from '../../../test-utils/fixtures.js';

describe('createMultipartUpload — cifrado en reposo (Q6)', () => {
    it('crea el multipart con ServerSideEncryption AES256', async () => {
        const s3mock = mockClient(S3Client);
        s3mock.on(CreateMultipartUploadCommand).resolves({ Key: 'k', UploadId: 'u1' });

        const req = makeAppRequest({
            brand: makeBrand({ slug: 'edo', assets: { s3Prefix: '' } }),
            user: makeUser({ id: '1004' }),
            body: { filename: 'f.jpg', type: 'image/jpeg' },
            method: 'POST',
        } as never);

        const json = vi.fn();
        const status = vi.fn(() => ({ json }));
        const res = { json, status } as never;

        await createMultipartUpload(req, res, (() => {}) as never);

        const calls = s3mock.commandCalls(CreateMultipartUploadCommand);
        expect(calls.length).toBe(1);
        expect(calls[0].args[0].input.ServerSideEncryption).toBe('AES256');
        s3mock.restore();
    });
});
```

> `makeBrand` incluye `limits.allowedContentTypes` = undefined por defecto, así que `image/jpeg` no es rechazado por `rejectIfOutsideLimits`.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test src/modules/companion/s3/s3.controller.test.ts`
Expected: FAIL — `input.ServerSideEncryption` es `undefined`.

- [ ] **Step 3: Implementar en `s3.controller.ts`**

En `createMultipartUpload`, añadir el campo al comando:

```ts
        const command = new CreateMultipartUploadCommand({
            Bucket: brand.s3.bucket,
            Key: key,
            ContentType: type,
            ServerSideEncryption: 'AES256', // Q6/H24: cifrado en reposo forzado (defensa en profundidad); heredado por todas las partes
            // ACL removed to respect bucket policies
        });
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm test src/modules/companion/s3/s3.controller.test.ts`
Expected: PASS.

- [ ] **Step 5: typecheck + build + commit**

Run: `pnpm typecheck && pnpm build`
Expected: limpio. (`'AES256'` es un literal válido del enum `ServerSideEncryption` del SDK.)

```bash
git add src/modules/companion/s3/s3.controller.ts src/modules/companion/s3/s3.controller.test.ts
git commit -m "feat(s3): forzar SSE-S3 (AES256) en el multipart create (Q6/H24, defensa en profundidad)"
```

---

### Task 4: Arreglar el build de imagen Docker + job de CI que lo valide (C1)

**Problema:** El `Dockerfile` hace `corepack enable pnpm && pnpm install` sin una versión de pnpm pineada; sin el campo `packageManager` en `package.json`, corepack resuelve una versión de pnpm distinta a la del lockfile (`lockfileVersion: '9.0'`, generado por pnpm 10.32.1) y el build de imagen falla en el `postinstall` de esbuild. Además CI usa `pnpm/action-setup@v4` con `version: 9` (desalineado con el 10.32.1 local) y **no** hay ningún job que construya la imagen, así que el fallo solo aparece en el deploy a Railway.

**Files:**
- Modify: `package.json` (añadir `packageManager`)
- Modify: `.github/workflows/ci.yml` (alinear pnpm + nuevo job `docker`)
- Modify (si hace falta): `Dockerfile` (sin cambios si el pin basta; ver Step 4)

**Interfaces:** ninguna (cambios de tooling/CI).

- [ ] **Step 1: Pinear `packageManager` en `package.json`**

Añadir el campo (junto a `"private": true` / `"type": "module"`), con la versión local exacta:

```json
    "packageManager": "pnpm@10.32.1",
```

- [ ] **Step 2: Verificar que pnpm sigue resolviendo local**

Run: `pnpm install --frozen-lockfile`
Expected: OK, sin cambios en `pnpm-lock.yaml` (lockfile ya en `9.0`, compatible con pnpm 10.32.1).

- [ ] **Step 3: Alinear la versión de pnpm en CI**

En `.github/workflows/ci.yml`, en el job `test`, quitar el pin `version: 9` para que `pnpm/action-setup@v4` lea el campo `packageManager`:

```yaml
            - uses: pnpm/action-setup@v4
```

(borrar las líneas `with:` / `version: 9` de ese step; el resto del step de setup-node con `cache: pnpm` no cambia).

- [ ] **Step 4: Verificar el build de imagen localmente**

Run: `docker build -t companion:ci .`
Expected: la imagen construye; el stage `builder` completa `pnpm run build` y emite `dist/`. Si `corepack enable pnpm` aún no fija 10.32.1 en el contenedor, añadir en los tres `RUN corepack enable pnpm` del `Dockerfile` una activación explícita:

```dockerfile
RUN corepack enable pnpm && corepack prepare pnpm@10.32.1 --activate && pnpm install --frozen-lockfile
```

(aplicar el mismo patrón a los stages `deps`, `prod-deps` y `builder`). Solo hacerlo si el pin del `packageManager` por sí solo no basta en tu entorno Docker.

> Si Docker no está disponible en el entorno de trabajo, dejar este step verificado por inspección y confiar en el nuevo job de CI (Step 5) para validarlo.

- [ ] **Step 5: Añadir el job `docker` en CI**

En `.github/workflows/ci.yml`, añadir un job nuevo (hermano de `test`) que construya la imagen. Es un gate de entrega: valida que la imagen de Railway construye de verdad.

```yaml
    docker:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - name: Build production image
              run: docker build -t companion:ci .
```

> Alcance: SOLO `docker build` (valida que la imagen y el `pnpm run build` in-image funcionan). Un `docker run` + curl a `/api/healthz` NO se incluye: el arranque real requiere `COMPANION_SECRET` + secretos S3 de un brand servable (el boot hace fail-fast sin ellos), así que un smoke-run necesitaría env/Redis y queda fuera de este task.

- [ ] **Step 6: Commit**

```bash
git add package.json .github/workflows/ci.yml Dockerfile
git commit -m "ci(delivery): pinear pnpm@10.32.1 (corepack) y validar docker build en CI (C1)"
```

---

## Verificación final (tras las 4 tareas)

- [ ] `pnpm lint` → exit 0 (los 47 warnings preexistentes de `uppyModal.ts`/`uppy.html` son H21, esperados).
- [ ] `pnpm typecheck` → limpio.
- [ ] `pnpm build` → OK.
- [ ] `pnpm test:coverage` → todos verdes; coverage ≥ 70/60/70/70.
- [ ] Abrir PR contra `main` (nunca commitear a `main` directo). Revisar comentarios de Copilot bajo criterio propio.

---

## Fuera de alcance (no implementable en el repo o requiere decisión/infra)

**Requiere verificación/acción de infra (Railway/AWS) — no código:**
- **Q1 / N9** — Smoke test SA1/SA2/SA4 contra stage + sign-off de edonext antes de escribir a `entourage-uploads` (bucket compartido). Usa `scripts/smoke-whoami-stage.ts`. **Es el gate del MVP.**
- **Q2 / N2** — Verificar IAM policy vs. `HeadBucket` de `/api/readyz`; si es least-privilege, cambiar la sonda (o dará 403 → readyz nunca OK → sin tráfico).
- **Q3 / N7** — Confirmar ≥2 réplicas + readiness path `/api/readyz` en Railway; opcionalmente versionar `railway.json`.
- **Q4 / N3** — Ajustar `trust proxy` a los hops reales de Railway.
- **Q6 (infra)** — Confirmar/activar cifrado por defecto del bucket (el complemento del código de Task 3).

**Requiere decisión de producto/seguridad (preguntar antes):**
- **C2** — Endurecer `/api/brands` (vista básica sin auth expone slugs/nombres). Es un cambio de contrato; decidir si exigir `HEALTH_CHECK_KEY` también en la vista básica o restringir por Host de operador.

**Diferido conscientemente a Fase 8 (esfuerzo alto o dependencias):**
- **N4 / C4** — Micro-caché negativa de `401`/`unauthenticated`. Bajo (mitigado por el limitador per-IP). Trade-off: cachear un 401 retrasa hasta el TTL el reconocimiento de un login recién hecho. Implementar solo si el volumen anónimo lo justifica.
- **M1 (H13)** — Enforcement server-side de tamaño en multipart vía presigned POST (`content-length-range`). Toca `uppyModal.ts` (browser).
- **M2 (H21)** — Tipar `uppyModal.ts` (quitar `@ts-nocheck` + ~22 `any`), idealmente a paquete propio.
- **M3 (N6)** — Atomizar el breaker (`INCR`+`SET open` con Lua/MULTI) cuando CI corra contra Redis real (testcontainers); `ioredis-mock` no ejecuta Lua.
- **M4** — STS/TVM + ABAC por tenant (solo si se migra a AWS o un partner exige aislamiento IAM).
- **M5** — OpenTelemetry + métricas Prometheus.

---

## Self-Review (hecho al escribir el plan)

- **Cobertura de la spec de mejoras:** Task 1↔N1/Q5, Task 2↔N5/C3, Task 3↔Q6(código), Task 4↔C1. Los ítems de infra (Q1–Q4, N2/N3/N7/N9), decisión (C2) y Fase 8 (N4, M1–M5) quedan explícitamente fuera de alcance con su razón.
- **Placeholders:** ninguno — cada step lleva código o comando concreto.
- **Consistencia de tipos:** `buildScriptSrc(brand, nonce)` se define en Task 1 y se consume en `server.ts` con la misma firma; `validateWhoamiUrl` se consume con la firma real exportada en `identity.ts`; `ServerSideEncryption: 'AES256'` es literal válido del SDK.
- **Riesgo de regresión identificado:** el gate SSRF de folders (Task 2) rompe un test existente con host off-allowlist → Step 4 lo ajusta explícitamente.
