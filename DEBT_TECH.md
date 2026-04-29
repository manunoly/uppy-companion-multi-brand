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

## 4. Bearer token expuesto en el HTML de `/uppy`

**Origen:** PR #3 review de Copilot (comentario sobre `BEARER_TOKEN_VALUE` en `uppy.html`).
**Estado:**
- **Option A (cookie-only via shared registrable domain):** ✅ **DISEÑO APROBADO** — implementación pendiente. Spec en `docs/superpowers/specs/2026-04-29-cookie-only-cross-origin-auth-design.md`.
- **Option B (BFF proxy para multi-tenant):** ⏳ **Diferida** — solo necesaria cuando Companion vive en un registrable domain distinto al backend de la marca (caso multi-tenant SaaS).

### Resumen del problema

Hoy `uppy.html` recibe el bearer token del usuario como literal JS (`const bearerToken = '<token>'`). Cualquier XSS en la página puede leerlo, anulando el goal de `HttpOnly` en la cookie. El token está ahí porque `uppyModal.ts:125` lo necesita para llamar al `publicUploadUrl` cross-origin (donde la cookie de Companion no viaja por defecto).

Detalle completo y threat model: ver el spec linkeado arriba.

---

### Option A — Cookie-only via shared registrable domain (en camino)

Companion y el backend de la marca comparten un registrable domain (ej. `companion.abeduls.com` + `api.abeduls.com`, ambos bajo `.abeduls.com`). El backend setea su cookie de session con `Domain=.abeduls.com`, así viaja automáticamente a TODOS los subdominios. Todos los `fetch()` de Uppy usan `credentials: 'include'`. El token nunca entra al JS.

**Por qué se eligió:** simple, sin proxy, sin código de impersonation. El usuario confirmó que su backend ya setea la cookie con `Domain=.<rootDomain>`.

**Trade-off aceptado:** asume que toda marca en producción comparte registrable domain con su Companion. Marcas multi-tenant (Companion en `uploads.platform.com/abeduls`) NO están cubiertas.

Spec: `docs/superpowers/specs/2026-04-29-cookie-only-cross-origin-auth-design.md`.

---

### Option B — BFF proxy (diferida hasta tener un caso multi-tenant)

#### Cuándo pasar a B

Si la plataforma evoluciona a "Companion como SaaS multi-tenant" donde una sola instancia de Companion sirve a marcas que NO controlan el dominio donde Companion está hospedado. Ejemplo concreto:

- Companion en `uploads.platform.com/abeduls` (operado por nosotros).
- Backend de Abeduls en `api.abeduls.com` (operado por la marca).
- No hay registrable domain compartido → la cookie cross-subdomain no se puede usar.

En ese caso A no funciona y necesitamos B.

#### Diseño de B (resumen)

La página JS de `/uppy` deja de llamar directamente a `publicUploadUrl`. En vez de eso llama a un nuevo endpoint **same-origin** en Companion:

```
POST companion.platform.com/abeduls/api/uppy/complete-upload
  Body: { images: [...], folder: ... }
  Cookie: companion-session=...   (HttpOnly, never readable by JS)
```

Companion (server-side):

1. Lee la cookie de Companion (HttpOnly).
2. Resuelve el bearer token de la marca asociado a esa session (puede estar en la session store de Companion, o re-validar contra `auth.url`).
3. Hace el call al `publicUploadUrl` con `Authorization: Bearer <token>` desde el server.
4. Devuelve la respuesta del backend al JS de la página.

El JS nunca ve el bearer. Defense-in-depth máximo.

#### Por qué es DEUDA y no se hace ahora

1. **No hay caso multi-tenant en producción hoy.** YAGNI.
2. **Trabajo significativo:**
   - Nuevo endpoint en `apiRouter` (`/api/uppy/complete-upload`) que proxy-ea a `publicUploadUrl`.
   - Almacén server-side de tokens del brand asociados a sessions de Companion (Redis o session store con encrypted payload).
   - Manejo de expiración / refresh.
   - Refactor de `uppyModal.ts:saveFileToDB` para llamar a Companion en vez del backend.
   - CORS de Companion no necesita cambios pero CSRF tokens sí (porque el endpoint Companion es same-origin con la página, pero alguien podría triggerear un POST desde otro tab).
3. **Latencia agregada:** un hop extra (browser → Companion → brand backend) en lugar de directo (browser → brand backend).
4. **Más superficie a securizar** del lado server (token storage, replay protection, request signing).

#### Esfuerzo estimado

~4-6 h de implementación + ~2 h de threat modeling para token storage + replay. Plus pruebas e2e con un brand multi-tenant simulado.

#### Trigger para activar

Crear este ítem como issue de GitHub con etiqueta `design/multi-tenant` el día que se firme el primer cliente que NO controla su Companion subdomain.

---

### Option C — CSP + SRI hardening (independiente de A y B)

Independientemente de cómo se autentique, la página `/uppy` carga scripts desde CDNs externos (`releases.transloadit.com/uppy/...`, `cdnjs.cloudflare.com/sweetalert2/...`) sin Subresource Integrity hashes. Si una de esas CDNs se compromete, atacante ejecuta código arbitrario en `/uppy`.

Mitigación:
1. CSP estricto (`script-src 'self' https://releases.transloadit.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; ...`).
2. `integrity="sha384-..."` en cada `<script src=...>` y `<link rel=stylesheet>` externo.

**Esfuerzo:** ~30 min. Independiente de A/B. Vale hacerlo en cuanto haya tiempo.

