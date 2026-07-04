# Guía de Configuración: Google Picker (Drive & Photos)

Este documento sirve como referencia técnica para la integración de selectores de archivos de Google dentro del ecosistema de **Abeduls.com**. Como desarrollador de software, esta guía te ayudará a evitar errores comunes de validación y permisos en la Google Cloud Console.

---

## 🚀 Checklist de Google Cloud Console

Antes de realizar pruebas en local o producción, verifica este checklist:

### 1. APIs Habilitadas
- [ ] **Google Picker API**: (Crítico) Obligatoria para abrir la ventana de selección de Drive.
- [ ] **Google Drive API**: Necesaria para la lectura y descarga de archivos.
- [ ] **Google Photos Library API**: Necesaria para el selector de fotos.

### 2. Identificación Visual de Credenciales (Know-how)
Nunca utilices el *Client Secret* en el frontend. Aquí está la guía de prefijos para identificarlas:

| Campo Uppy | Nombre en Google Cloud | Formato / Prefijo | Ubicación |
| :--- | :--- | :--- | :--- |
| `apiKey` | **API Key** | Empieza con **`AIza...`** | Sección "Claves de API" |
| `key` | **OAuth Client ID** | Termina en **`.apps.googleusercontent.com`** | Sección "ID de cliente OAuth 2.0" |
| `appId` | **Project Number** | **Solo números** (ej: `10218990210`) | Dashboard principal del proyecto |
| `secret` | **Client Secret** | Empieza con **`GOCSPX-...`** | ⚠️ **SOLO en variables de entorno del servidor** |

### 3. Restricciones de Seguridad para la API Key (`AIza...`)
Para evitar el error `API developer key is invalid`, configura la llave pública con estas restricciones:

* **Restricciones de aplicación**: Selecciona "Sitios web" e incluye:
    * `http://localhost:3000` (Frontend local)
    * `http://localhost:3020` (Companion local)
    * `https://*.abeduls.com` (Producción)
* **Restricciones de API**: Selecciona "Restringir clave" y añade explícitamente **Google Picker API**.

### 4. Configuración de OAuth 2.0 (Orígenes y Redirecciones)
En tu **Client ID** de OAuth, asegúrate de tener estas rutas exactas:

* **Authorized JavaScript origins**:
    * `http://localhost:3000`
    * `https://designer.abeduls.com`
* **Authorized redirect URIs (Rutas de Companion)**:
    * `http://localhost:3020/drive/callback`
    * `http://localhost:3020/google/callback`
    * `https://companion.abeduls.com/drive/callback`

---

## 🛠 Implementación en Uppy (Frontend)

Asegúrate de que el objeto de configuración use los valores correctos obtenidos del checklist anterior:

```javascript
uppy.use(GoogleDrive, {
  companionUrl: 'http://localhost:3020', // Tu servidor Node.js
  key: 'TU_CLIENT_ID.apps.googleusercontent.com',
  apiKey: 'AIzaSyA...', // DEBE empezar por AIza
  appId: '10218990210',  // Número de proyecto (App ID)
})

## Tips de Utilidad y Troubleshooting

Error 401 Unauthorized: Si aparece al invocar el Picker, revisa que la apiKey tenga permitido el origen (localhost) y que la Google Picker API esté habilitada en el proyecto correcto.

Diferencia Drive vs Photos: Google Photos es más flexible, pero Google Drive requiere obligatoriamente el appId (Project Number). Sin él, el selector nunca abrirá.

Propagación: Los cambios en las restricciones de las llaves en Google Cloud pueden tardar de 3 a 5 minutos en hacerse efectivos.

Seguridad de Secretos: El valor GOCSPX-... es una credencial privada. Si se filtra en el código cliente, debe rotarse inmediatamente en la consola de Google.


# Guía de Configuración: Google Picker (Drive & Photos)

Este documento es la referencia técnica para la integración de selectores de archivos de Google en el ecosistema de **Abeduls.com**. Como desarrollador de software, esta guía te ayudará a evitar errores de validación y permisos en la Google Cloud Console.

---

## 🚀 Checklist de Google Cloud Console

### 1. APIs Habilitadas
- [ ] **Google Picker API**: Obligatoria para abrir la interfaz de selección de Drive.
- [ ] **Google Drive API**: Necesaria para la lectura y descarga de archivos.
- [ ] **Google Photos Library API**: Necesaria para el selector de fotos.

### 2. Identificación de Credenciales (Know-how)
| Campo Uppy | Nombre en Google Cloud | Formato / Prefijo | Ubicación |
| :--- | :--- | :--- | :--- |
| `apiKey` | **API Key** | Empieza con **`AIza...`** | Sección "Claves de API" |
| `key` | **OAuth Client ID** | Termina en **`.apps.googleusercontent.com`** | Sección "ID de cliente OAuth 2.0" |
| `appId` | **Project Number** | **Solo números** (ej: `10218990210`) | Dashboard del proyecto |
| `secret` | **Client Secret** | Empieza con **`GOCSPX-...`** | ⚠️ **SOLO en el servidor (.env)** |

### 3. Restricciones de Seguridad (API Key)
Configura la llave pública (`AIza...`) con estas restricciones:
* **Sitios web**: Añade `http://localhost:3000`, `http://localhost:3020` y `https://*.abeduls.com`.
* **APIs**: Restringir específicamente a **Google Picker API**.

---

## ⚙️ Configuración del Servidor Companion (Node.js)

En tu servidor Node.js (corriendo en `localhost:3020`), debes configurar las variables de entorno para que Companion pueda intercambiar los códigos de autorización de forma segura.

### Archivo `.env` (Servidor)
```bash
# Google OAuth
COMPANION_GOOGLE_KEY="TU_CLIENT_ID.apps.googleusercontent.com"
COMPANION_GOOGLE_SECRET="GOCSPX-TU_CLIENT_SECRET" # El código que empieza por GOCSPX

# Configuración de URLs
COMPANION_DOMAIN="localhost:3020"
COMPANION_PROTOCOL="http" # Cambiar a 'https' en producción (abeduls.com)

# Opciones de Uppy
COMPANION_DATADIR="./output" # Directorio temporal para descargas