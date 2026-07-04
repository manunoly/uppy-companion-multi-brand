# ADR-001: Modelo de tenancy — pool por Host con puerta de escape a bridge/silo

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Manuel Almaguer (ECS Yearbooks / Entourage Yearbooks)
- **Related:** `docs/superpowers/specs/2026-07-02-companion-multibrand-alineacion-abeduls3-design.md` (D4, D8, D12), `docs/superpowers/plans/2026-07-02-companion-multibrand-alineacion-abeduls3.md` (Fase 0, Task 0.0)

## Contexto

`companion-platform-multi-brand` aloja instancias de `@uppy/companion` para varias marcas del grupo ECS Yearbooks (Entourage Yearbooks / `edo`, Picaboo Yearbooks / `picaboo`, RememberMe Yearbooks, y `abe` de abeduls3), cada una con sus propias credenciales OAuth, bucket S3 y backend de autenticación (whoami del partner).

Hasta ahora la resolución de marca se hacía por **path** (`/{brandId}/...`, montaje Express por segmento de URL). El realineamiento con el contrato de marca de abeduls3 (`@package/brands`) cambia esto a resolución por **`Host`** exact-match contra un allowlist `companionHosts` por marca (ver D4), lo cual obliga a decidir explícitamente **cómo se reparten las marcas entre procesos/servicios/infraestructura** — es decir, el modelo de tenancy. Esta decisión se toma **antes** de escribir el código de resolución (`resolveBrandByHost`, Task 2.5) porque cambia la superficie de aislamiento (blast radius de un fallo o brecha de una marca sobre las demás) y no es trivial de revertir una vez hay tráfico de producción en varias marcas dentro del mismo proceso.

El deploy inicial es **Railway** (no ECS/AWS). El único recurso AWS del sistema es **S3** (un bucket por marca, p. ej. `entourage-uploads` para `edo`); no hay IAM role de instancia en Railway, por lo que el `S3Client` usa access key / secret key explícitas provistas como variables de servicio de Railway.

## Opciones consideradas

1. **Pool puro** — un único proceso/servicio sirve todas las marcas, resueltas dinámicamente por `Host` en cada request. Máxima eficiencia de recursos y menor complejidad operativa; el "ruido vecino" (noisy neighbor) y el blast radius de un incidente de seguridad o disponibilidad son compartidos entre marcas.
2. **Bridge (semi-aislado)** — igual que el pool en código y despliegue, pero con una puerta de escape declarativa (`BRAND_FORCE=<slug>`) que permite arrancar una réplica del **mismo binario** dedicada a una sola marca (un servicio/deploy por marca) sin bifurcar el código base.
3. **Silo puro** — un repositorio/servicio/infraestructura totalmente separado por marca desde el día uno (cuentas AWS separadas, buckets con políticas IAM independientes, STS scoped por tenant, procesos de release independientes).

## Decisión

Adoptamos el **modelo pool por defecto, con puerta de escape a bridge/silo vía `BRAND_FORCE`** (opción 2), con la infraestructura inicial (Railway + Redis del plugin de Railway + S3) compartida entre marcas.

### Cómo funciona

- **Modo pool (default, `BRAND_FORCE` sin definir):** un único proceso Node/Express aloja una instancia `@uppy/companion` aislada en memoria por marca (mapa `slug → companion.app(...)`), todas montadas en el mismo servidor HTTP. `resolveBrandByHost(req.headers.host)` hace **exact-match** contra el `companionHosts` de cada marca (registro `src/modules/brand/registry.ts`, code-only, no overridable) y adjunta `req.brand`. Host desconocido en producción → **404** explícito, nunca fallback silencioso a otra marca.
- **Modo bridge (`BRAND_FORCE=<slug>`):** el mismo binario, la misma imagen de contenedor y el mismo código de resolución, pero `resolveBrandByHost` ignora el `Host` entrante y siempre resuelve a `<slug>`. Esto permite desplegar una réplica de Railway (o un servicio ECS más adelante) **dedicada a una sola marca**, detrás de su propio dominio/apex, sin bifurcar código. Es la puerta de entrada hacia un modelo silo si una marca lo necesita.
- **Aislamiento reforzado ya presente en el modo pool** (no se difiere a un silo para obtenerlo):
  - **Por marca:** bucket S3 propio (no prefijo compartido `brands/{slug}/`), credenciales OAuth propias, cookie de sesión de partner propia (`sessionCookieName` por marca), `whoamiAllowedHosts` no overridable (SSRF gate).
  - **Estado compartido en Redis** (plugin de Railway) namespacing por marca: caché whoami (`companion-whoami:{slug}:...`), circuit breaker (`whoami:breaker:{slug}`), rate-limit por `{slug}:{userId|ip}`. Redis en sí es compartido entre marcas (mismo `REDIS_URL`); el aislamiento es lógico (namespace), no físico.
  - **Secretos:** variables de servicio de Railway (marcadas *sealed*) por marca; AWS Secrets Manager queda como fuente **opcional** (`SECRETS_SOURCE=aws`) para cuando/si se migre a AWS/ECS — no es un requisito del MVP en Railway.
  - **Diferido a Fase 8** (no bloquea el MVP): credenciales S3 con alcance por tenant vía STS/TVM (Token Vending Machine) + ABAC, en vez de una única access key con acceso a todos los buckets de marca.

### Criterios de activación del modo bridge/silo

Se activa `BRAND_FORCE` (o se evalúa un silo completo) para una marca cuando se cumpla **cualquiera** de:

- **Volumen:** el tráfico de una marca satura una réplica compartida de forma sostenida (noisy neighbor medible en métricas de latencia/CPU del proceso pool) y el escalado horizontal del pool completo no es coste-efectivo frente a aislar esa marca.
- **Compliance/contractual:** un partner exige aislamiento de infraestructura demostrable (p. ej. cuenta AWS separada, ausencia de vecinos multi-tenant en el mismo proceso) como condición contractual o regulatoria (datos de menores, auditoría externa, etc.).
- **Incidente de seguridad:** una brecha o vulnerabilidad explotada contra una marca requiere contener el blast radius separando esa marca del proceso compartido mientras se remedia.
- **SLA diferenciado:** una marca requiere un SLA de disponibilidad o un ciclo de release independiente del resto (deploys más frecuentes/lentos, ventanas de mantenimiento propias) que el pool compartido no puede dar sin afectar a las demás marcas.

Ninguno de estos criterios se cumple hoy para `edo`, `picaboo` o `abe`: el MVP arranca en modo pool.

## Consecuencias

**Positivas:**
- Un solo código base y un solo pipeline de CI/CD para todas las marcas mientras el volumen lo permita; menor coste operativo en la fase inicial (una réplica de Railway sirve varias marcas).
- La puerta de escape (`BRAND_FORCE`) no requiere reescribir el código de resolución de marca ni bifurcar el repositorio — es un flag de entorno sobre el mismo binario, disponible desde el día uno.
- El aislamiento por bucket S3 + credenciales por marca + `whoamiAllowedHosts` no overridable ya limita el blast radius de fugas de datos cruzadas entre marcas dentro del modo pool, sin esperar a un silo.

**Negativas / riesgos aceptados:**
- Un incidente de disponibilidad del proceso compartido (p. ej. un memory leak inducido por una marca, o saturación de Redis) puede degradar a **todas** las marcas simultáneamente hasta que se identifique y, si aplica, se active `BRAND_FORCE` para aislar la marca causante.
- Redis es un recurso compartido entre marcas; un fallo de Redis (o de su plugin de Railway) afecta a la sesión OAuth, la caché whoami, el breaker y el rate-limit de **todas** las marcas a la vez (mitigado parcialmente por `GET /api/readyz` y fail-fast del breaker, pero no elimina el acoplamiento).
- El STS/TVM scoped por tenant (aislamiento IAM fuerte) queda diferido a Fase 8; hasta entonces, las credenciales S3 de una marca comprometidas no están limitadas por política IAM a nivel de proceso más allá del bucket configurado para esa marca.
- Migrar una marca de pool a bridge no es instantáneo: requiere aprovisionar una réplica/dominio dedicado en Railway (o infraestructura equivalente) y coordinarlo con DNS; no es un cambio de un solo flag sin trabajo operativo adicional.

## Alternativas descartadas

- **Silo puro desde el día uno** se descartó por sobre-ingeniería: no hay hoy ningún criterio de activación (volumen, compliance, incidente, SLA) que lo justifique, y habría multiplicado el coste operativo del MVP (3 marcas × infraestructura independiente) sin beneficio medible a corto plazo.
- **Pool puro sin puerta de escape** se descartó porque cerraría la opción de aislar una marca bajo presión sin una reescritura de arquitectura; `BRAND_FORCE` tiene coste de implementación marginal (un flag en `resolveBrandByHost`) y evita quedar atrapados en el modelo pool si un criterio de activación se materializa.
