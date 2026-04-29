# Technical Debt

Deferred improvements identified during code audits. Each entry describes the gap, why it matters, and a suggested implementation path. Items here are intentional postponements — they should be picked up when the surrounding area is touched or when prioritized as a standalone task.

---

## 1. `/api/brands` no debe ser un endpoint público

**Origen:** Auditoría de código del 2026-04-29 (bonus #1).
**Estado:** Diferido. La comparación del shared-secret se endureció con `crypto.timingSafeEqual` en `src/server.ts`, pero la decisión arquitectónica de mantener el endpoint accesible desde internet sigue abierta.

### Por qué importa

`GET /api/brands?key=…` devuelve, cuando se autentica con `HEALTH_CHECK_KEY`, la configuración completa por marca: URLs del backend, nombre/región de los buckets S3, parte del `clientId` de OAuth, últimos 4 caracteres de cada secreto, orígenes CORS y plugins habilitados. Aunque los secretos se enmascaran, el conjunto es una mina de reconocimiento para un atacante que esté mapeando la infraestructura: nombres de buckets, dominios internos, qué proveedores OAuth están activos por marca, etc.

Los líderes de la industria mantienen este tipo de superficie de inspección **fuera de internet pública**:

- **Vercel** expone sus rutas `_internal/*` solo dentro de su red interna.
- **Datadog y Honeycomb** tienen endpoints de debug accesibles únicamente desde la VPC del operador o vía herramienta CLI autenticada.
- **AWS** ofrece APIs `Describe*` que requieren credenciales IAM, nunca shared-secrets en query string.

El patrón general es: **el tráfico público recibe `id` + `displayName` y nada más; la inspección detallada va por un canal privado.**

### Recomendación de implementación

1. **Dividir el handler en dos endpoints:**
   - `GET /api/brands` (público) → solo `[{ id, displayName }]`. Sin chequeo de key, sin rama detallada.
   - `GET /api/brands/details` (privado) → la vista enmascarada actual.

2. **Restringir el endpoint privado** con uno de estos mecanismos (en orden de preferencia):
   - **Allowlist por IP / red interna.** Middleware `requireInternalNetwork` que rechace si `req.ip` no está en loopback ni en el CIDR privado de la plataforma (Railway private networking, AWS VPC, etc.). Es el corte más limpio: sin red interna no hay forma de llegar al handler.
   - **mTLS.** Si el dashboard de operadores ya habla con el servicio, exigir certificado de cliente.
   - **Eliminar el endpoint HTTP.** Mover la inspección a un script CLI (`scripts/inspect-brands.ts`) que lea `process.env` directamente y formatee el mismo output. Los operadores lo ejecutan vía `kubectl exec` / `railway run` / SSH contra el contenedor en marcha. Es el patrón con **menor superficie de ataque**: no hay endpoint que atacar.

3. **Si `HEALTH_CHECK_KEY` sigue existiendo**, tratarlo como credencial de break-glass (rotar tras cada uso, almacenar en vault, no dejarlo en `.env` largo plazo).

### Esfuerzo estimado

~2–3 horas: split de la ruta, middleware de allowlist o script CLI, actualización del README y de `.env.example`.

---

## 2. Tipado estricto en el browser bundle (`uppyModal.ts`) y en el factory de Companion

**Origen:** Auditoría 2026-04-29 (top-10 #4).
**Estado:** Diferido. Los `any` server-side fueron tipados (`s3.controller.ts`); los del bundle de browser y el bridge a `@uppy/companion` siguen abiertos.

### Lugares afectados

- `src/modules/companion/uppyModal.ts` — ~17 ocurrencias de `any` en callbacks (`file: any`, `result: any`, etc.) y casts `body: serialize(...) as any` para sortear la firma estricta de `fetch`.
- `src/modules/companion/companion.factory.ts:161` — `companion.app(options as Parameters<typeof companion.app>[0])`. Cast de bridge porque `CompanionOptions` (local) no matchea exactamente la firma exportada.

### Por qué importa

`tsconfig.json` está en `strict` con `noImplicitAny`, pero estos `any` lo neutralizan en los puntos de mayor superficie (browser callbacks ejecutan código del usuario; el bridge define toda la config server-to-Companion). Un typo en `file.size`, en el shape del response del fetch, o en una option de Companion **se descubre en runtime, no en typecheck**.

Industry equivalent: el ecosistema de Uppy históricamente expone tipos genéricos abiertos (`UppyFile`, `Body`) que son difíciles de aterrizar en TS estricto. Vercel/Next.js resuelve un problema similar publicando wrappers con tipos concretos por endpoint.

### Recomendación de implementación

1. **`uppyModal.ts`**:
   - Importar `UppyFile`, `Meta`, `Body`, `UppyEventMap` desde `@uppy/core` y `@uppy/utils`.
   - Reemplazar `(file: any)` por `(file: UppyFile<Meta, Body>)` en los handlers (`onBeforeFileAdded`, `thumbnail:generated`, `upload-success`, etc.).
   - Para los `body: serialize(...) as any`: refactorizar `serialize` para que devuelva `string | URLSearchParams` y eliminar el cast.
   - Considerar mover `uppyModal.ts` a un paquete propio (`packages/uppy-modal`) ya planeado en `docs/ROADMAPFuturo.md` §7. Eso permite pinear versiones de Uppy y publicar tipos firmes.

2. **`companion.factory.ts:161`**:
   - Investigar si `@uppy/companion` exporta una interfaz `CompanionOptions` consumible. Si sí, importarla y eliminar la interfaz local en `companion.types.ts`.
   - Si no, mantener el cast pero acotarlo: `as Parameters<typeof companion.app>[0]` está bien como bridge documentado; agregar comentario `// Bridge to @uppy/companion — types not exported cleanly`.

### Esfuerzo estimado

~4–6 horas para `uppyModal.ts` (es interop, hay que probar que los uploads sigan funcionando end-to-end). ~30 min para el factory si los tipos de Companion están exportados; >2 h si hay que escribir adapters.

---

## 3. Logger estructurado (reemplazar `console.log`/`console.error`)

**Origen:** Auditoría 2026-04-29 (top-10 #5).
**Estado:** Diferido. El log de debug hardcoded de `abeduls` se eliminó; el resto del proyecto sigue usando `console.*` directamente.

### Lugares afectados

Todos los módulos: `[brand]`, `[server]`, `[companion]`, `[s3]`, `[auth]`, `[uppy]`, `[folders]` usan `console.log` / `console.error` con prefijos string. No hay niveles, no hay correlación por request, no hay JSON estructurado.

### Por qué importa

1. **No hay niveles.** Cuando algo falla en producción, no se puede filtrar `WARN+` sin que `console.log` rutinario inunde el output.
2. **No hay correlación por request.** Es imposible reconstruir un flujo end-to-end (¿qué auth, qué brand, qué upload corresponden a un mismo request?). OWASP ASVS V7.1.4 pide logs correlacionables.
3. **No es JSON.** Datadog, Honeycomb, CloudWatch Insights, todos parsean JSON nativo. Strings con prefijo requieren regex que se rompen al menor cambio de formato.
4. **Industry standard:** pino (Vercel, Fastify default), winston (clásico), bunyan. Todos producen JSON estructurado, niveles, child loggers para correlación.

### Recomendación de implementación

1. Adoptar **pino** (más rápido, menos overhead que winston, default de Fastify, usado por Vercel internamente).
2. Crear `src/lib/logger.ts` que exporte un logger raíz configurado por env (`LOG_LEVEL=info|debug|warn|error`).
3. Middleware de Express (`pino-http`) que añada `req.log` con `requestId` y método/path/status — todos los logs del request quedan correlacionados.
4. Reemplazar `console.log('[brand] ...')` por `logger.info({ brand: brand.id }, '...')` y similares.
5. En `req.log`-conscious code (rutas), usar `req.log.warn({err}, 'auth failed')`.

### Esfuerzo estimado

~3–4 horas: instalar pino + pino-http, crear logger.ts, migrar ~30 sitios de `console.*`. Bajo riesgo (cambio mecánico, comportamiento idéntico al final).

---

## 4. Bearer token expuesto en el HTML de `/uppy` (HttpOnly bypass de facto)

**Origen:** PR #3 review de Copilot (comentario sobre `BEARER_TOKEN_VALUE` en `uppy.html`).
**Estado:** Diferido. La cookie del flujo `/uppy` ya es `HttpOnly: true` y el query param desaparece del URL vía 302 redirect, pero el servidor inyecta el token literal en el HTML como variable JS (`BEARER_TOKEN_VALUE`) — cualquier XSS en la página puede leerlo igual.

### Por qué se inyecta hoy

`src/modules/companion/uppyModal.ts:125` arma `Authorization: Bearer ${BEARER_TOKEN}` para llamar al **`publicUploadUrl`** del backend de la marca (ej. `https://api.abeduls.com/api/frame/contents/upload/public`). Ese backend está en un origen distinto al de Companion → la cookie de Companion no se envía en cross-origin, así que se necesita el token en JS para autenticar la llamada.

### Por qué importa

OWASP A03 (Injection / XSS) y la *Session Management Cheat Sheet*: si una XSS roba el token, tiene acceso completo a la cuenta del usuario en el backend de la marca. `HttpOnly` en la cookie de Companion no protege porque el mismo token vive como string en `window.bearerToken` de la página.

### Opciones de fix (orden de preferencia)

1. **Token efímero de uso único firmado por el backend de la marca.** El backend emite un token corto (TTL ~5 min, single-use) específico para este upload. La página JS solo ve ese token-corto. Si se filtra, expira solo. Patrón de **Stripe Checkout sessions**, **Auth0 magic links**.
2. **Proxy del upload-completion por Companion.** La página JS llama a un nuevo `/api/uppy/complete-upload` en Companion (same-origin, cookie HttpOnly), y Companion hace el call al backend de la marca con el token (que vive solo server-side). El JS nunca ve el token. Defense-in-depth máximo.
3. **Status quo + risk acceptance.** Documentar que cualquier XSS en `/uppy` es game-over. Aceptable solo si la página gana CSP estricto, no acepta input de usuario inline, y dependencias front (Uppy, sweetalert2 desde CDN) tienen integrity hashes.

### Esfuerzo estimado

- Opción 1: ~4-6 h (cambios en backend de la marca para emitir tokens cortos + Companion + `uppyModal.ts`).
- Opción 2: ~2-3 h (nuevo endpoint en `/api/uppy/` + refactor en `uppyModal.ts:saveFileToDB`).
- Opción 3: 30 min (CSP + integrity hashes + nota en CLAUDE.md).

