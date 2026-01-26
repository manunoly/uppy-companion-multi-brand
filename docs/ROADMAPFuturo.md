# Companion Platform - Technical Roadmap

Este documento describe las mejoras planificadas para hacer el proyecto más mantenible, escalable y fácil de desarrollar.

---

## 🔴 Alta Prioridad

### 1. Testing Framework

**Estado**: ❌ No implementado

**Objetivo**: Agregar tests unitarios e integración para garantizar estabilidad.

```
tests/
├── unit/
│   ├── auth.service.test.ts
│   ├── brand.service.test.ts
│   ├── folders.service.test.ts
│   └── s3.key-builder.test.ts
└── integration/
    ├── uppy.routes.test.ts
    └── s3.controller.test.ts
```

**Dependencias a agregar**:
```json
{
  "devDependencies": {
    "vitest": "^3.x",
    "supertest": "^7.x",
    "@types/supertest": "^6.x"
  }
}
```

**Scripts**:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

---

### 2. Linting y Formatting

**Estado**: ❌ No implementado

**Objetivo**: Consistencia de código y detección temprana de errores.

**Dependencias**:
```json
{
  "devDependencies": {
    "eslint": "^9.x",
    "@typescript-eslint/eslint-plugin": "^8.x",
    "@typescript-eslint/parser": "^8.x",
    "prettier": "^3.x",
    "eslint-config-prettier": "^10.x"
  }
}
```

**Archivos de configuración**:
- `eslint.config.mjs` - Configuración ESLint flat config
- `.prettierrc` - Configuración Prettier
- `.prettierignore` - Archivos a ignorar

**Scripts**:
```json
{
  "scripts": {
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "format": "prettier --write src/"
  }
}
```

---

### 3. Logging Estructurado

**Estado**: ❌ No implementado (usa console.log)

**Objetivo**: Logs JSON para producción, trazabilidad con request IDs.

**Dependencias**:
```json
{
  "dependencies": {
    "pino": "^9.x",
    "pino-http": "^10.x"
  },
  "devDependencies": {
    "pino-pretty": "^13.x"
  }
}
```

**Implementación**:
```typescript
// src/lib/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' 
    ? { target: 'pino-pretty' } 
    : undefined,
});
```

---

## 🟡 Media Prioridad

### 4. Configuración por Archivos YAML

**Estado**: ❌ No implementado (usa JSON en env vars)

**Objetivo**: Facilitar gestión de múltiples brands.

**Estructura propuesta**:
```
config/
├── brands/
│   ├── abeduls.yaml
│   ├── another-brand.yaml
│   └── default.yaml
└── defaults.yaml
```

**Formato**:
```yaml
# config/brands/abeduls.yaml
displayName: Abeduls
auth:
  url: https://api.abeduls.com/api/user
  cookieName: session
public:
  backendUrl: https://api.abeduls.com
  foldersUrl: /api/folders
s3:
  bucket: abeduls-uploads
  region: us-east-1
providers:
  google:
    clientId: xxx.apps.googleusercontent.com
  dropbox:
    key: xxx
```

---

### 5. Docker Support

**Estado**: ❌ No implementado

**Archivos a crear**:
- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`

```dockerfile
# Dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
RUN npm i -g pnpm
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
EXPOSE 3020
CMD ["node", "dist/index.js"]
```

---

### 6. Health Checks Mejorados

**Estado**: ⚠️ Básico implementado

**Mejoras propuestas**:
```typescript
// GET /healthz
{
  "status": "ok",
  "timestamp": 1706284800000,
  "checks": {
    "s3": { "status": "ok", "latencyMs": 45 },
    "memory": { "heapUsed": "128MB", "heapTotal": "256MB" },
    "uptime": "2h 15m"
  },
  "brands": {
    "abeduls": { "authUrl": "reachable" },
    "default": { "authUrl": "not_configured" }
  }
}
```

---

### 7. Separar uppyModal como Paquete

**Estado**: ❌ No implementado (transpila on-the-fly)

**Objetivo**: Pre-compilar para mejor performance y versionado.

**Estructura propuesta**:
```
packages/
└── uppy-modal/
    ├── src/
    │   └── index.ts
    ├── dist/
    │   └── uppyModal.min.js
    ├── package.json
    └── tsconfig.json
```

---

## 🟢 Baja Prioridad

### 8. OpenAPI Documentation

**Objetivo**: Documentación automática de API.

**Endpoints a documentar**:
| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Health check |
| GET | `/api/brands` | List brands |
| GET | `/{brand}/uppy` | Upload page |
| POST | `/{brand}/api/uppy/sign-s3` | Sign S3 URL |
| POST | `/{brand}/api/uppy/s3/multipart` | Create multipart |

---

### 9. Rate Limiting

**Dependencias**:
```json
{
  "dependencies": {
    "express-rate-limit": "^7.x"
  }
}
```

**Configuración recomendada**:
- `/api/*`: 100 req/min por IP
- `/{brand}/uppy`: 30 req/min por IP
- S3 signing: 60 req/min por usuario

---

### 10. Métricas Prometheus

**Dependencias**:
```json
{
  "dependencies": {
    "prom-client": "^15.x"
  }
}
```

**Métricas a exponer**:
- `companion_uploads_total{brand, status}`
- `companion_auth_duration_seconds{brand}`
- `companion_s3_signing_duration_seconds`

---

### 11. CLI para Gestión de Brands

**Comandos propuestos**:
```bash
pnpm brand:list              # Lista brands configurados
pnpm brand:validate          # Valida configuración
pnpm brand:add <slug>        # Wizard interactivo
pnpm brand:test <slug>       # Test de conectividad
```

---

### 12. Cache de Autenticación

**Objetivo**: Reducir llamadas a auth.url.

**Implementación con memoria**:
```typescript
const authCache = new Map<string, { user: AuthUser; expiresAt: number }>();
const TTL = 30_000; // 30 segundos

export const authenticateWithCache = async (token: string, brand: Brand) => {
  const cached = authCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return { authenticated: true, user: cached.user };
  }
  // ... llamar authenticate() y guardar en cache
};
```

---

## 📊 Matriz de Priorización

| Mejora | Esfuerzo | Impacto | Prioridad |
|--------|----------|---------|-----------|
| Testing | 🔴 Alto | ⬆️ Muy Alto | **P0** |
| ESLint/Prettier | 🟢 Bajo | ⬆️ Alto | **P0** |
| Logging | 🟡 Medio | ⬆️ Alto | **P0** |
| Config YAML | 🟡 Medio | ⬆️ Alto | **P1** |
| Docker | 🟢 Bajo | ➡️ Medio | **P1** |
| Health checks | 🟢 Bajo | ➡️ Medio | **P1** |
| Separar uppy-modal | 🟡 Medio | ➡️ Medio | **P2** |
| OpenAPI docs | 🟡 Medio | ➡️ Medio | **P2** |
| Rate limiting | 🟢 Bajo | ➡️ Medio | **P2** |
| Métricas | 🟡 Medio | ➡️ Medio | **P3** |
| CLI brands | 🟡 Medio | ⬇️ Bajo | **P3** |
| Auth cache | 🟢 Bajo | ⬇️ Bajo | **P3** |

---

## ✅ Checklist de Implementación

### Fase 1: Fundamentos (P0)
- [ ] Configurar Vitest + escribir tests críticos
- [ ] Agregar ESLint + Prettier
- [ ] Implementar Pino logger

### Fase 2: DevOps (P1)
- [ ] Crear Dockerfile y docker-compose
- [ ] Mejorar health checks
- [ ] Migrar a config YAML (opcional)

### Fase 3: Producción (P2)
- [ ] Separar uppy-modal como paquete
- [ ] Agregar OpenAPI/Swagger
- [ ] Implementar rate limiting

### Fase 4: Observabilidad (P3)
- [ ] Métricas Prometheus
- [ ] CLI para brands
- [ ] Cache de autenticación
