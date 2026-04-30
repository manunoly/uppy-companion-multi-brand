# Vitest Test Suite — Design Spec

**Fecha**: 2026-04-29
**Autor**: Manuel Almaguer (con asistencia de Claude Code)
**Estado**: Listo para implementación

## Goal

Agregar Vitest al proyecto y escribir una suite de tests inicial cubriendo el núcleo crítico (funciones puras y de seguridad) y la integración HTTP de Express, con CI automatizado en GitHub Actions y umbral de cobertura del 70% que falla la build si baja.

## Non-Goals

- Tests del cliente del navegador (`src/modules/companion/uppyModal.ts`). Si más adelante se quieren probar, debe ser end-to-end con Playwright en una iteración separada.
- Tests del bootstrap (`src/index.ts`, `src/config/env.ts`). El comportamiento se verifica indirectamente vía `env.schema.ts` y los tests de integración con app construida explícitamente.
- Internals de `@uppy/companion`, `@aws-sdk/client-s3` o Express.
- Branch protection en `main` (decisión que el usuario hará en GitHub UI cuando se sienta cómodo con la suite).

## Scope

**Cobertura objetivo**: ~120 tests en total — ~80 unit + ~40 integration HTTP.

| Módulo | Tipo | Tests | Foco |
|---|---|---|---|
| `src/modules/brand/brand.utils.ts` | unit | ~6 | `normalizeBrandSlug` |
| `src/modules/brand/brand.schema.ts` | unit | ~12 | Zod + `superRefine` rootDomain↔authUrl |
| `src/modules/brand/brand.service.ts` | unit | ~15 | parsing, merge precedence, `getBrand`/`getAllBrands` |
| `src/modules/brand/brand.middleware.ts` | unit | ~6 | `createBrandMiddleware` |
| `src/modules/auth/auth.service.ts` | unit | ~10 | `extractToken` (header → cookie), `attachUser` |
| `src/modules/auth/auth.middleware.ts` | unit | ~5 | `requireAuth`, `attachUser` middleware |
| `src/modules/folders/folders.service.ts` | unit | ~6 | success + degradación silenciosa a `[]` |
| `src/modules/companion/s3/s3.key-builder.ts` | unit | ~6 | shape del key, throw sin `req.user` |
| `src/core/cors.ts` | unit | ~12 | regex HTTPS-only en prod, localhost dev, anti-bypass |
| `src/config/env.schema.ts` | unit | ~8 | required, secret length, protocol enum |
| `src/modules/companion/uppy.routes.ts` (helpers exportados) | unit | ~10 | `toJsStringLiteral`, `safeJsonForHtmlScript`, `safePath` |
| `src/modules/companion/api.routes.ts` | integration | ~8 | sign-s3, multipart create/sign/list/complete/abort |
| `src/modules/companion/s3/s3.controller.ts` | integration | ~6 | `requireAuth` gate, brand-scoped client, presigner |
| `src/server.ts` (assembled app) | integration | ~12 | mount `/{brand}`, strip `/default/`, `/uppy` redirect, CORS preflight, `/api/healthz`, `/api/brands` |

**Total: ~120 tests**.

## Architecture & Workflow

### Branch

Nueva rama `feat/vitest-suite` desde `origin/main`. PR #4 (`feat/cookie-only-auth`) sigue su curso por separado; cuando mergee a `main`, esta rama se rebasa contra `main`.

### Stack

Todas como devDependencies:

- `vitest` — runner, watcher, expect API
- `@vitest/coverage-v8` — coverage provider nativo (sin instrumentación de Babel)
- `aws-sdk-client-mock` — mock para AWS SDK v3 (S3Client + presigner)
- `supertest` + `@types/supertest` — integración HTTP contra Express app

### Configuración Vitest

Archivo `vitest.config.ts` en raíz del repo:

- Globs incluidos: `src/**/*.test.ts`
- `globals: true` — `describe`/`it`/`expect` accesibles sin import explícito
- Coverage provider: `v8`, reporters `text` + `html` + `json-summary`
- Coverage thresholds globales: **70% lines, 60% branches, 70% functions, 70% statements**. Si la suite baja de eso, `pnpm test:coverage` falla y el job de CI se rompe.
- Coverage excludes:
  - `src/**/index.ts` (barrels)
  - `src/index.ts` (bootstrap)
  - `src/config/env.ts` (bootstrap; el contrato se prueba via `env.schema.test.ts`)
  - `src/modules/companion/uppyModal.ts` (browser ESM, fuera de scope)
  - `**/*.types.ts` (puros type aliases)
  - `**/*.test.ts`
  - `src/test-utils/**`
  - `dist/**`, `node_modules/**`, `scripts/**`

### Split de tsconfig

`tsconfig.json` (raíz) sigue como está hoy — usado por IDE, `pnpm typecheck`, vitest. Incluye todo `src/**/*`.

`tsconfig.build.json` nuevo:

```json
{
    "extends": "./tsconfig.json",
    "exclude": [
        "node_modules",
        "dist",
        "**/*.test.ts",
        "src/test-utils/**"
    ]
}
```

`pnpm build` se actualiza a `tsc -p tsconfig.build.json && node scripts/build-assets.mjs` para que `dist/` no contenga archivos de test ni el directorio `test-utils/`.

### Refactors mínimos para testabilidad

**Solo lo justo, no más**:

1. **Exportar tres helpers en `src/modules/companion/uppy.routes.ts`**: `toJsStringLiteral`, `safeJsonForHtmlScript`, `safePath`. Cambio puro de scope (de `const` privado a `export const`). Razón: son unidades de seguridad pequeñas y bien definidas; testearlos directo es más limpio que probarlos por completo via integración HTML.
2. **Extraer `assembleApp` en `src/server.ts`**: La función `createServer()` actual mezcla "leer env + construir registry" con "ensamblar middleware en Express". Para integration tests se extrae:

   ```ts
   export const assembleApp = (params: {
       env: EnvConfig;
       brandRegistry: BrandRegistry;
       companionInstances: CompanionInstance[];
   }): express.Express => { /* todo el wiring de middleware */ };

   export const createServer = (): ServerResult => {
       const brandRegistry = createBrandRegistry({ /* ...desde env... */ });
       const companionInstances = [/* ...build... */];
       const app = assembleApp({ env, brandRegistry, companionInstances });
       return { app, brandRegistry, companionInstances };
   };
   ```

   Cero cambios de comportamiento en producción — `createServer()` sigue siendo el entry point. `createTestApp()` en `test-utils/http.ts` llama directo a `assembleApp(...)` con env y brands inyectados.
3. **NO** se refactoriza `src/config/env.ts` ni `src/lib/aws/s3Client.ts`. El bootstrap de env se cubre testeando `env.schema.ts` directo. AWS no necesita inyección de dependencias gracias a `aws-sdk-client-mock`.
4. **NO** se cambian signaturas de handlers ni middlewares.

### Mocks

#### AWS SDK

`aws-sdk-client-mock` para `S3Client` y `@aws-sdk/s3-request-presigner`:

```ts
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Mock = mockClient(S3Client);

beforeEach(() => s3Mock.reset());

it('signs put-object', async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: 'abc' });
    // ... call code under test
});
```

Para el presigner (`@aws-sdk/s3-request-presigner`) se usa `vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn().mockResolvedValue('https://signed.url') }))`.

#### `@uppy/companion`

`vi.mock('@uppy/companion')` a nivel de archivo. Stubs de `app(options)` y `socket(server)` que devuelven valores neutros. Las aserciones se centran en lo que **pasamos** a `companion.app(...)`, no en lo que companion hace internamente.

#### `fetch` (para `folders.service.ts` y `auth.service.ts`)

`vi.stubGlobal('fetch', vi.fn(...))` por test, con reset en `beforeEach`. Se aserta sobre URL, headers (cookie forwarding) y manejo de errores de red.

#### Variables de entorno

Tests de unidad de `env.schema.ts` invocan `envSchema.safeParse({...})` con objetos en memoria — no se toca `process.env`.

Tests de integración usan `createTestApp({ brands, env })` (ver `test-utils/http.ts`) para inyectar configuración explícita sin atravesar el bootstrap.

## File Layout

```
src/
├── modules/
│   ├── brand/
│   │   ├── brand.utils.ts
│   │   ├── brand.utils.test.ts
│   │   ├── brand.schema.ts
│   │   ├── brand.schema.test.ts
│   │   ├── brand.service.ts
│   │   ├── brand.service.test.ts
│   │   ├── brand.middleware.ts
│   │   └── brand.middleware.test.ts
│   ├── auth/
│   │   ├── auth.service.ts
│   │   ├── auth.service.test.ts
│   │   ├── auth.middleware.ts
│   │   └── auth.middleware.test.ts
│   ├── companion/
│   │   ├── uppy.routes.ts
│   │   ├── uppy.routes.test.ts
│   │   ├── api.routes.ts
│   │   ├── api.routes.integration.test.ts
│   │   └── s3/
│   │       ├── s3.key-builder.ts
│   │       ├── s3.key-builder.test.ts
│   │       ├── s3.controller.ts
│   │       └── s3.controller.integration.test.ts
│   └── folders/
│       ├── folders.service.ts
│       └── folders.service.test.ts
├── core/
│   ├── cors.ts
│   └── cors.test.ts
├── config/
│   ├── env.schema.ts
│   └── env.schema.test.ts
├── server.ts
├── server.integration.test.ts
└── test-utils/
    ├── fixtures.ts
    ├── env-fixtures.ts
    └── http.ts
```

### Convención de naming

- `*.test.ts` — tests unitarios (rápidos, sin Express/Companion). Vitest los descubre por defecto.
- `*.integration.test.ts` — tests que arrancan el Express app via `supertest`. Mismo runner, naming distinto para identificarlos a simple vista (no se usa para filtrar — vitest los corre todos por defecto; ver sección "Scripts" para correr subsets).

### Fixtures compartidas (`src/test-utils/`)

#### `fixtures.ts`

```ts
export const makeBrand = (overrides?: DeepPartial<Brand>): Brand => ({ ... });
export const makeBrandRegistry = (brands?: Brand[]): BrandRegistry => ({ ... });
export const makeAppRequest = (overrides?: Partial<AppRequest>): AppRequest => ({ ... });
```

Brand por defecto: `id: 'test'`, `displayName: 'Test'`, `rootDomain: 'test.example.com'`, `auth.url: 'https://api.test.example.com/auth/me'`, `auth.cookieName: 'session'`, providers vacíos, S3 con bucket dummy y región dummy.

Variantes específicas: `makeBrandWithAuthDisabled()` (sin `auth.url`, sin `rootDomain`), `makeBrandWithGoogle()` (provider Google configurado).

#### `env-fixtures.ts`

`makeValidEnv(overrides?)` — devuelve un objeto que pasa `envSchema.parse` con valores dummy válidos.

#### `http.ts`

`createTestApp({ brands?, env? })` — usa la `assembleApp(...)` exportada desde `src/server.ts` (ver sección "Refactors mínimos") para construir un `Express.Application` con brands y env explícitos. Si `brands` no se provee, usa `[makeBrand()]`. Si `env` no se provee, usa `makeValidEnv()`. Devuelve `{ app, brandRegistry }` para que tests puedan asertar sobre cualquiera. Mockea `@uppy/companion` y AWS SDK antes de construir, para que `createCompanionForBrand` y `getS3Client` no toquen recursos reales.

## Coverage Detail per Module

### `brand.utils.test.ts`

- `normalizeBrandSlug('Acme')` → `'acme'`
- `normalizeBrandSlug('  brand-x  ')` → `'brand-x'`
- `normalizeBrandSlug('Brand_X!')` → `'brand-x'` (caracteres no permitidos colapsan)
- `normalizeBrandSlug('')` → `''`
- `normalizeBrandSlug('---')` → `''` (todos los chars colapsan)
- `normalizeBrandSlug('a--b')` → `'a-b'` (deduplica dashes)

### `brand.schema.test.ts`

- Schema válido mínimo
- `auth.url` set sin `rootDomain` → falla con mensaje específico
- `auth.url` set con `rootDomain` → pasa
- Sin `auth.url` y sin `rootDomain` → pasa (auth desabilitada)
- `rootDomain` sin formato dominio (e.g., `'foo'`) → falla
- `rootDomain` con esquema (e.g., `'https://foo.com'`) → falla
- `loginUrl` no es URL válida → falla
- Provider con clientId vacío → pasa schema (la verificación es warning no error)
- `enabledPlugins` con valor desconocido → tolerado (deduplicación silenciosa ocurre en service)
- `s3.bucket` opcional
- Legacy `authUrl` flat field → aceptado para backwards-compat
- Combo nested `auth.*` y legacy `authUrl` → nested gana

### `brand.service.test.ts`

- `parseBrandConfigs('a,b,c')` con todas las JSON envs definidas → 3 brands
- Slug duplicado en CSV → dedup silencioso
- `BRAND_A` con JSON inválido → brand omitido + error reportado
- `BRAND_A` con JSON que falla schema → brand omitido + error reportado
- `BRAND_A` undefined → brand creado con defaults globales
- `createBrand` con JSON que define `s3.bucket` y `AWS_BUCKET_NAME` global definido → JSON gana
- `createBrand` con `enabledPlugins: 'Url, GOOGLEDRIVEPICKER, dropbox'` → array `['Url', 'GoogleDrivePicker', 'Dropbox']` (case-insensitive match contra allowlist)
- `createBrand` con `enabledPlugins: 'Url, FakePlugin'` → `'FakePlugin'` se omite silencioso
- `getBrand(registry, 'a')` → brand A
- `getBrand(registry, 'desconocido')` → fallback a default brand
- `getAllBrands(registry)` → lista en orden de `COMPANION_BRANDS`
- `createBrand` sin `auth.url` y sin `rootDomain` → brand creado con `rootDomain: null`
- `createBrand` sin `enabledPlugins` → derivación desde providers configurados
- Companion URL: `companionUrl` se setea desde `${protocol}://${host}/${brand.id}`
- Default brand id: primer slug en `COMPANION_BRANDS`

### `brand.middleware.test.ts`

- `createBrandMiddleware` con `req.params.brand = 'a'` → `req.brand` apunta a brand A
- Con `req.query.brand = 'a'` → `req.brand` apunta a brand A
- Con header `x-brand: 'a'` → `req.brand` apunta a brand A
- Con todos vacíos → `req.brand` apunta a default
- Con valor desconocido → `req.brand` apunta a default
- Prioridad params > query > header

### `auth.service.test.ts`

- `extractToken` con `Authorization: Bearer xyz` → `'xyz'`
- `extractToken` con cookie `session=xyz` → `'xyz'` cuando brand.cookieName es `'session'`
- `extractToken` con header **y** cookie → header gana
- `extractToken` sin nada → `null`
- `extractToken` con `Authorization: Basic ...` → `null` (rechaza otros schemes)
- `extractToken` con `?bearerToken=xyz` query → `null` (NO honra query, OWASP V8.3.1)
- `attachUser` con backend OK + JSON válido → setea `req.user`
- `attachUser` con backend 401 → no setea `req.user`, no throw
- `attachUser` con backend 500 → no setea `req.user`, no throw
- `attachUser` con fetch network error → no setea `req.user`, no throw
- `attachUser` reenvía cookie del request al backend (`Cookie: session=xyz`)

### `auth.middleware.test.ts`

- `requireAuth` con `req.user` set → `next()`
- `requireAuth` sin `req.user` → `res.status(401).json({...})`
- `requireAuth` sin `req.user` + sin brand auth.url → 401 igual (defensa en profundidad)
- `attachUserMiddleware` ejecuta `attachUser` y llama `next()` aún en error
- `attachUserMiddleware` con `req.brand` ausente → llama `next()` sin tocar req.user

### `folders.service.test.ts`

- `fetchUserFolders` con backend OK + JSON `{folders: [...]}` → array de folders
- Con backend OK pero `folders` ausente → `[]`
- Con backend 401 → `[]` (degradación silenciosa)
- Con backend 500 → `[]`
- Con fetch network error → `[]`
- Sin `brand.public.foldersUrl` configurada → `[]`

### `s3.key-builder.test.ts`

- `buildS3Key` con todos los inputs válidos → match regex `^test/original/u123/2026/4/29/\d+/foo\.jpg$`
- Sin `req.user` → throw con mensaje específico
- Filename con caracteres especiales → sanitización
- Brand id en path
- Timestamp incrementa entre llamadas
- Year/month/day del año/mes/día de la fecha "actual" (mockear `Date.now()` con `vi.useFakeTimers`)

### `cors.test.ts`

- `corsForBrand(brandSinRootDomain, ...)` → middleware no-op (next sin headers)
- `corsForBrand(brand, 'https')` con origin `https://app.brand.example` → echoes Allow-Origin
- Con origin `http://app.brand.example` en prod → no echoes (HTTPS-only)
- Con origin `http://app.brand.example` en dev → echoes
- Con origin `http://localhost:3000` en dev → echoes (excepción literal)
- Con origin `http://localhost:3000` en prod → no echoes
- Con origin `https://evil.com.brand.example` (subdominio falso bajo el atacante) → no echoes (regex requiere `.<rootDomain>` literal al final con boundary)
- Sin header `Origin` → next sin headers
- OPTIONS preflight → 204 con todos los headers
- `Allow-Credentials: true` presente cuando origin es válido
- `Vary: Origin` mergea con Vary existente (no sobrescribe)
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Max-Age: 600`

### `env.schema.test.ts`

- Valid env mínimo → parse OK
- `COMPANION_SECRET` < 16 chars → falla
- `COMPANION_SECRET` ausente → falla
- `COMPANION_BRANDS` ausente → falla (o default según schema actual)
- `COMPANION_PROTOCOL` con valor no `http`/`https` → falla
- `HEALTH_CHECK_KEY` opcional
- `AWS_REGION` opcional
- Coerción de tipos donde aplique

### `uppy.routes.test.ts` (helpers)

- `toJsStringLiteral('hello')` → `"'hello'"`
- `toJsStringLiteral` con `\\` → escapado
- `toJsStringLiteral` con `'` → escapado
- `toJsStringLiteral` con `\n` y `\r` → `\\n` y `\\r`
- `toJsStringLiteral` con `<` y `>` → `\\u003C`, `\\u003E`
- `toJsStringLiteral` con U+2028 y U+2029 → `\\u2028`, `\\u2029`
- `safeJsonForHtmlScript({a: '</script>'})` → no contiene `</script>`, JSON.parse roundtrips
- `safeJsonForHtmlScript` con U+2028 → `\\u2028` en output
- `safePath('/foo')` → `'/foo'`
- `safePath('//evil.com')` → fallback (rechaza protocol-relative)
- `safePath('http://evil.com')` → fallback
- `safePath('javascript:alert(1)')` → fallback
- `safePath('')` → fallback

### `api.routes.integration.test.ts`

Helper: `createTestApp({brands: [makeBrand()]})`, mock S3 con `aws-sdk-client-mock`.

- `POST /test/api/uppy/sign-s3` sin auth → 401
- Con auth (cookie válida + `attachUser` mock OK) → 200 con URL firmada
- `POST /test/api/uppy/multipart` (create) → S3 mock devuelve UploadId, response 200
- `GET /test/api/uppy/multipart/:uploadId/:partNumber` → presigner llamado con Command correcto
- `GET /test/api/uppy/multipart/:uploadId` (list parts) → 200 con lista
- `POST /test/api/uppy/multipart/:uploadId/complete` → S3 mock recibe CompleteMultipartUploadCommand
- `DELETE /test/api/uppy/multipart/:uploadId` → S3 mock recibe AbortMultipartUploadCommand
- Sin brand attachment → 404 (route nunca matchea)

### `s3.controller.integration.test.ts`

- `requireAuth` gate: cada endpoint sin auth → 401
- Cliente S3 usado es brand-scoped (assert que el comando llegó al mock instanciado con la región de la brand)
- Presigner llamado con Bucket = brand.s3.bucket (no global default cuando brand tiene su propio)
- Key builder integrado: el key del PutObjectCommand sigue el patrón `{brand}/original/{userId}/...`
- Errores AWS (e.g., `s3Mock.on(...).rejects(new Error('access denied'))`) → 500 con mensaje genérico
- Tamaño máximo o tipo MIME (si está validado en el handler) → rechazo correcto

### `server.integration.test.ts`

- `GET /test/uppy` sin cookie → 302 a `loginUrl?redirect=...`
- `GET /test/uppy` con cookie + `attachUser` OK → 200 con HTML conteniendo brand slug correcto
- `GET /test/uppy` con cookie + `attachUser` falla → 302 a login (fallback)
- `GET /test/uppy` sin `loginUrl` configurada → 401 con HTML estático
- `GET /default/test/oauth/google/callback` → strip a `/test/oauth/google/callback` antes de Companion
- `GET /test/oauth/google/callback` → no strip
- `OPTIONS /test/api/uppy/sign-s3` con origin válido → 204 con headers CORS
- `GET /api/healthz` → 200 OK
- `GET /api/brands` sin key → array con `{id, displayName}` solamente
- `GET /api/brands?key=<correct>` → array con info detallada (secrets enmascarados)
- `GET /api/brands?key=<wrong>` → 200 con basic view (la política actual nunca devuelve 401: si la key no matchea, `showDetails === false` y se sirve el shape básico — verificado en `server.ts:105-208`)
- `GET /` → 404 (handler removido en sesión anterior)
- Headers de seguridad presentes: `Cache-Control: no-store` en `/uppy`, no en `/api/healthz`

## Scripts en `package.json`

```json
{
    "scripts": {
        "dev": "tsx watch src/index.ts",
        "build": "tsc -p tsconfig.build.json && node scripts/build-assets.mjs",
        "start": "node dist/index.js",
        "typecheck": "tsc --noEmit",
        "test": "vitest run",
        "test:watch": "vitest",
        "test:coverage": "vitest run --coverage"
    }
}
```

Para correr un subset durante desarrollo, vitest acepta paths como positional args nativos: `pnpm test src/modules/brand` o `pnpm test src/modules/brand/brand.utils.test.ts`. No se agregan scripts dedicados para `test:unit`/`test:integration` porque vitest no tiene un flag estable equivalente a Jest's `testPathPattern` y los aliases agregan mantenimiento sin ganancia clara.

Nota: el cambio en `build` de `tsc -p tsconfig.json` a `tsc -p tsconfig.build.json` es lo que evita que tests aparezcan en `dist/`.

## CI Workflow

Archivo `.github/workflows/ci.yml`:

```yaml
name: CI

on:
    push:
        branches-ignore: []
    pull_request:
        branches: [main]

jobs:
    test:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: pnpm/action-setup@v4
              with:
                  version: 9
            - uses: actions/setup-node@v4
              with:
                  node-version: 22
                  cache: pnpm
            - run: pnpm install --frozen-lockfile
            - run: pnpm typecheck
            - run: pnpm test:coverage
            - uses: actions/upload-artifact@v4
              if: always()
              with:
                  name: coverage-report
                  path: coverage/
                  retention-days: 7
```

Triggers:
- `push` a cualquier rama → corre CI (incluye topic branches durante desarrollo)
- `pull_request` contra `main` → corre CI y reporta status check en la PR

Si typecheck o tests fallan, el job termina con código no-cero. GitHub muestra ❌ rojo en la PR. Para bloquear merge se debe activar branch protection en GitHub UI (fuera de scope, decisión del usuario).

## Threat Model & Security Cases

Esta suite **debe** verificar las siguientes invariantes de seguridad para que un regression las rompa visiblemente:

1. **CORS HTTPS-only en prod** (`cors.test.ts`): origins HTTP bajo `<rootDomain>` no reciben `Allow-Credentials: true` cuando `envProtocol === 'https'`. Si esto se rompe, un atacante en `http://anywhere.brand.example` puede leer respuestas con credenciales.
2. **Anti-bypass del regex CORS** (`cors.test.ts`): origins como `https://evil.com.brand.example` (donde `<rootDomain>` aparece como **substring** sin ser el sufijo real) son rechazados.
3. **`extractToken` no honra query string** (`auth.service.test.ts`): `?bearerToken=xyz` no produce token. OWASP V8.3.1.
4. **`s3.key-builder` falla cerrado sin user** (`s3.key-builder.test.ts`): nunca cae a un userId default. OWASP API1:2023 (BOLA).
5. **`safePath` rechaza redirect abiertos** (`uppy.routes.test.ts`): `//`, `http:`, `javascript:` son rechazados.
6. **Inline-script escaping** (`uppy.routes.test.ts`): `</script>` payloads no escapan del `<script>` block. JSON sigue siendo válido.
7. **`requireAuth` falla cerrado** (varios): cualquier endpoint protegido sin user → 401, nunca 200.

## Operator Pre-Merge Checklist

Antes de mergear esta PR a `main`:

- [ ] `pnpm install` actualiza `pnpm-lock.yaml` con las nuevas devDeps
- [ ] `pnpm test:coverage` pasa localmente con threshold 70/60/70
- [ ] `pnpm typecheck` pasa
- [ ] `pnpm build` produce `dist/` sin archivos `.test.js` ni `test-utils/`
- [ ] CI verde en GitHub
- [ ] Spot-check de un test integration: arrancar `pnpm dev` y verificar que el comportamiento sigue siendo correcto

## Open Questions

Ninguna. Todas las decisiones quedaron resueltas durante el brainstorming.

## Risks & Tradeoffs

- **Aumento del CI time**: ~15-30s extra por PR (instalar deps + typecheck + test). Aceptable.
- **Mantenimiento de mocks**: si AWS SDK rompe API entre versiones, hay que actualizar los stubs. Mitigado con `aws-sdk-client-mock` que abstrae buena parte.
- **Falsos positivos de coverage**: V8 puede contar líneas no ejecutables (e.g., types). Mitigado con excludes explícitos.
- **Tests integration brittle al refactor**: arrancan el app completo, así que pequeños cambios de routing pueden cascadear en varios tests. Solo aceptable porque el wiring del Express app **es** el código de producción más frágil de este repo (gotcha del `createBrandMiddleware`, regex anti-`/default/`).

## Future Work

- **Subir a 90/95% threshold** y agregar thresholds por archivo en módulos de seguridad (PR separada cuando la suite madure).
- **Tests E2E con Playwright** del flujo `/uppy` real, incluyendo render del Dashboard de Uppy en `happy-dom`.
- **Branch protection** en `main` con status checks requeridos (decisión del usuario en GitHub UI).
- **Snapshot tests** para el HTML inyectado por `serveUppyPage` (decisión a futuro; suelen ser frágiles).
- **Integración con SonarQube/Codecov** para tracking de coverage en PRs.
