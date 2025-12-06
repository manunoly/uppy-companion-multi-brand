import {
    Uppy,
    Dashboard,
    // Proveedores de Companion
    Facebook,
    Dropbox,
    GoogleDrive,
    Instagram,
    OneDrive,
    Box,
    Unsplash,
    Zoom,
    Url,
    // Google Pickers
    GoogleDrivePicker,
    GooglePhotosPicker,
    // Plugins
    ThumbnailGenerator,
    AwsS3,
} from 'https://releases.transloadit.com/uppy/v5.1.8/uppy.min.mjs'

// Lista de plugins por defecto actualizada
const DEFAULT_PLUGINS = [
    'Facebook', 'Dropbox', 'GoogleDrive', 'Url', // Originales
    'Instagram', 'OneDrive', 'Box', 'Unsplash', 'Zoom', // Nuevos Companion
    'GoogleDrivePicker', 'GooglePhotosPicker' // Nuevos Pickers
]

const FOLDERS = ['home', 'share', 'my-folder']

const sanitizeName = (name) => name.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 999)

const serialize = (data) => {
    // ... (sin cambios en esta función)
    const params = new URLSearchParams()
    Object.entries(data || {}).forEach(([key, value]) => {
        if (value == null) return
        if (Array.isArray(value)) {
            value.forEach((item) => params.append(`${key}[]`, item))
        } else {
            params.append(key, value)
        }
    })
    return params
}

const readOption = (options, key, fallback) => {
    // ... (sin cambios en esta función)
    if (options[key] != null) return options[key]
    const element = document.getElementById(key)
    return element ? element.value : fallback
}

const createFolderSelect = (uppy) => {
    // ... (sin cambios en esta función)
    if (document.getElementById('uppyStaticFolder')) return
    const container = document.querySelector('.uppy-Dashboard-innerWrap')
    if (!container) return

    const wrapper = document.createElement('div')
    wrapper.className = 'uppy-DashboardTab'
    wrapper.style = 'padding:10px;display:flex;justify-content:center;'

    const select = document.createElement('select')
    select.id = 'uppyStaticFolder'
    select.style = 'width:200px;border-radius:8px;padding:6px;'

    FOLDERS.forEach((folder) => {
        const option = document.createElement('option')
        option.value = folder
        option.textContent = folder
        select.appendChild(option)
    })

    const setFolder = (value) => uppy.setMeta({ folder: value })
    select.addEventListener('change', () => setFolder(select.value))
    setFolder(select.value)

    wrapper.appendChild(select)
    container.insertBefore(wrapper, container.firstChild)
}

const shouldUseMultipart = (file) => file.size > 100 * 1024 * 1024

const uppyModal = (options = {}) => {
    const merged = {
        trigger: '#uppyModalOpener',
        inline: false,
        plugins: DEFAULT_PLUGINS,
        SERVER_URL: 'http://localhost:3000',
        COMPANION_URL: 'http://localhost:3020',
        COMPANION_ALLOWED_HOSTS: /.*/,
        LARAVEL_PUBLIC_BACKEND_URL: 'http://localhost',
        GOOGLE_API_KEY: null,
        GOOGLE_DRIVE_CLIENT_ID: null,
        callbackFn: null,
        brand: 'default',
        brandName: null,
        brandLogoUrl: null,
        brandUserEndpoint: null,
        ...options,
    }

    const SERVER_URL = readOption(merged, 'SERVER_URL', 'http://localhost:3000')
    const COMPANION_URL = readOption(merged, 'COMPANION_URL', 'http://localhost:3020')
    const COMPANION_ALLOWED_HOSTS = merged.COMPANION_ALLOWED_HOSTS ?? /.*/
    const LARAVEL_PUBLIC_BACKEND_URL = readOption(merged, 'LARAVEL_PUBLIC_BACKEND_URL', 'http://localhost')
    
    // Leer las nuevas claves de API de Google
    const GOOGLE_API_KEY = readOption(merged, 'GOOGLE_API_KEY', null);
    const GOOGLE_DRIVE_CLIENT_ID = readOption(merged, 'GOOGLE_DRIVE_CLIENT_ID', null);
    const BEARER_TOKEN = readOption(merged, 'bearerToken', null)

    const authHeaders = BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
    const mergeHeaders = (headers = {}) => ({ ...headers, ...authHeaders })
    const fetchWithAuth = (url, options = {}) => {
        const headers = mergeHeaders(options.headers)
        return fetch(url, { ...options, headers })
    }

    const uppy = new Uppy({
        debug: true,
        autoProceed: false,
        restrictions: {
            maxFileSize: 4 * 1024 * 1024 * 1024,
            maxNumberOfFiles: 600,
            minNumberOfFiles: 1,
        },
        onBeforeFileAdded: (file) => {
            // Evitar generar miniaturas de miniaturas
            if (file.meta.isThumbnail) {
                file.name = sanitizeName(file.name);
                return file;
            }
            file.name = sanitizeName(file.name)
            return file
        },
    })

    const initialMeta = {}
    if (merged.brand) initialMeta.brand = merged.brand
    if (merged.brandName) initialMeta.brandName = merged.brandName
    if (merged.brandLogoUrl) initialMeta.brandLogoUrl = merged.brandLogoUrl
    if (merged.brandUserEndpoint) initialMeta.brandUserEndpoint = merged.brandUserEndpoint
    if (Object.keys(initialMeta).length > 0) {
        uppy.setMeta(initialMeta)
    }

    if (merged.brandName) {
        document.body.dataset.brandName = merged.brandName
    }
    if (merged.brandLogoUrl) {
        document.body.dataset.brandLogoUrl = merged.brandLogoUrl
    }

    uppy.use(Dashboard, {
        trigger: merged.trigger,
        inline: merged.inline,
        proudlyDisplayPoweredByUppy: false,
        hideCancelButton: true,
        hidePauseResumeCancelButtons: true,
        hidePauseResumeButton: true,
        // Mostrar todos los plugins en la barra de pestañas
        plugins: merged.plugins,
    })

    // --- Inicialización de Plugins de Companion ---
    if (merged.plugins.includes('Facebook')) {
        uppy.use(Facebook, { target: Dashboard, companionUrl: COMPANION_URL })
    }
    if (merged.plugins.includes('Dropbox')) {
        uppy.use(Dropbox, { target: Dashboard, companionUrl: COMPANION_URL, companionAllowedHosts: COMPANION_ALLOWED_HOSTS })
    }
    if (merged.plugins.includes('GoogleDrive')) {
        uppy.use(GoogleDrive, { target: Dashboard, companionUrl: COMPANION_URL, companionAllowedHosts: COMPANION_ALLOWED_HOSTS })
    }
    if (merged.plugins.includes('Url')) {
        uppy.use(Url, { target: Dashboard, companionUrl: COMPANION_URL })
    }
    // --- Nuevos Plugins de Companion ---
    if (merged.plugins.includes('Instagram')) {
        uppy.use(Instagram, { target: Dashboard, companionUrl: COMPANION_URL })
    }
    if (merged.plugins.includes('OneDrive')) {
        uppy.use(OneDrive, { target: Dashboard, companionUrl: COMPANION_URL })
    }
    if (merged.plugins.includes('Box')) {
        uppy.use(Box, { target: Dashboard, companionUrl: COMPANION_URL })
    }
    if (merged.plugins.includes('Unsplash')) {
        uppy.use(Unsplash, { target: Dashboard, companionUrl: COMPANION_URL })
    }
    if (merged.plugins.includes('Zoom')) {
        uppy.use(Zoom, { target: Dashboard, companionUrl: COMPANION_URL })
    }

    // --- Nuevos Google Pickers ---
    if (merged.plugins.includes('GoogleDrivePicker')) {
        uppy.use(GoogleDrivePicker, {
            target: Dashboard,
            clientId: GOOGLE_DRIVE_CLIENT_ID,
            apiKey: GOOGLE_API_KEY,
            companionUrl: COMPANION_URL, // Sigue necesitando Companion para procesar
        });
    }
    if (merged.plugins.includes('GooglePhotosPicker')) {
        uppy.use(GooglePhotosPicker, {
            target: Dashboard,
            clientId: GOOGLE_DRIVE_CLIENT_ID, // Reutiliza el Client ID
            apiKey: GOOGLE_API_KEY,
            companionUrl: COMPANION_URL,
        });
    }

    // --- Añadir Generador de Miniaturas ---
    uppy.use(ThumbnailGenerator, {
        thumbnailWidth: 200, // Ancho deseado
        waitForThumbnailsBeforeUpload: false, // No bloquear la subida
    });

    // --- Lógica de subida de Miniaturas ---
    uppy.on('thumbnail:generated', async (file, preview) => {
        // 'file' es el archivo original
        // 'preview' es un blob URL de la miniatura
        
        // No generar miniaturas para miniaturas
        if (file.meta.isThumbnail) return;

        try {
            const response = await fetch(preview);
            const blob = await response.blob();
            
            // Crear un nuevo objeto File para la miniatura
            const thumbnailFile = new File([blob], `thumb_${file.name}`, { 
                type: blob.type 
            });

            // Añadir la miniatura a Uppy como un nuevo archivo para subir
            uppy.addFile({
                name: thumbnailFile.name,
                type: thumbnailFile.type,
                data: thumbnailFile,
                meta: {
                    ...file.meta, // Copiar metadatos (como 'folder') del padre
                    isThumbnail: true, // Marcar como miniatura
                    originalFileName: file.name, // Referencia al original
                },
            });
        } catch (err) {
            console.error('Error al crear el archivo de miniatura:', err);
        }
    });

    // --- Lógica de S3 (sin cambios) ---
    const ensureFolderSelect = () => createFolderSelect(uppy)
    uppy.on('dashboard:modal-open', ensureFolderSelect)
    uppy.on('dashboard:mount', ensureFolderSelect)
    setTimeout(ensureFolderSelect, 0)

    uppy.use(AwsS3, {
        getTemporarySecurityCredentials: false,
        shouldUseMultipart,
        
        // ... (resto de tu lógica de AwsS3: getUploadParameters, createMultipartUpload, etc.)
        // ... (esta parte permanece sin cambios)
        async getUploadParameters(file, options) {
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/sign-s3`, {
                method: 'POST',
                body: serialize({
                    filename: sanitizeName(file.name),
                    contentType: file.type,
                }),
                signal: options.signal,
            })

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response })

            const data = await response.json()

            if ((!file.uploadURL || file.uploadURL === 'undefined' || file.uploadURL === 'null') && data.url) {
                file.uploadAwsUrl = decodeURIComponent(data.url.split('?')[0])
            } else if (file.uploadURL && file.uploadURL !== 'undefined' && file.uploadURL !== 'null') {
                file.uploadAwsUrl = decodeURIComponent(file.uploadURL.split('?')[0])
            }

            return {
                method: data.method,
                url: data.url,
                fields: {},
                headers: {
                    'Content-Type': file.type,
                },
            }
        },

        async createMultipartUpload(file, signal) {
            if (signal?.aborted) {
                const err = new DOMException('The operation was aborted', 'AbortError')
                Object.defineProperty(err, 'cause', { configurable: true, writable: true, value: signal.reason })
                throw err
            }

            const metadata = {}
            Object.keys(file.meta || {}).forEach((key) => {
                if (file.meta[key] != null) {
                    metadata[key] = file.meta[key].toString().replace(/[^a-zA-Z0-9.]/g, '')
                }
            })

            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart`, {
                method: 'POST',
                body: serialize({
                    filename: sanitizeName(file.name),
                    type: file.type,
                    metadata,
                }),
                signal,
            })

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response })

            return response.json()
        },

        async abortMultipartUpload(file, { key, uploadId }, signal) {
            const filename = encodeURIComponent(key)
            const uploadIdEnc = encodeURIComponent(uploadId)
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart/${uploadIdEnc}?key=${filename}`, {
                method: 'DELETE',
                signal,
            })

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response })
        },

        async signPart(file, options) {
            const { uploadId, key, partNumber, signal } = options

            if (signal?.aborted) {
                const err = new DOMException('The operation was aborted', 'AbortError')
                Object.defineProperty(err, 'cause', { configurable: true, writable: true, value: signal.reason })
                throw err
            }

            if (uploadId == null || key == null || partNumber == null) {
                throw new Error('Cannot sign without a key, an uploadId, and a partNumber')
            }

            const filename = encodeURIComponent(key)
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart/${uploadId}/${partNumber}?key=${filename}`, {
                signal,
            })

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response })

            return response.json()
        },

        async listParts(file, { key, uploadId }, signal) {
            if (signal?.aborted) {
                const err = new DOMException('The operation was aborted', 'AbortError')
                Object.defineProperty(err, 'cause', { configurable: true, writable: true, value: signal.reason })
                throw err
            }

            const filename = encodeURIComponent(key)
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart/${uploadId}?key=${filename}`, {
                signal,
            })

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response })

            const data = await response.json()
            return data && data.parts ? data.parts : []
        },

        async completeMultipartUpload(file, { key, uploadId, parts }, signal) {
            if (signal?.aborted) {
                const err = new DOMException('The operation was aborted', 'AbortError')
                Object.defineProperty(err, 'cause', { configurable: true, writable: true, value: signal.reason })
                throw err
            }

            const filename = encodeURIComponent(key)
            const uploadIdEnc = encodeURIComponent(uploadId)
            const response = await fetchWithAuth(`${SERVER_URL}/api/uppy/s3/multipart/${uploadIdEnc}/complete?key=${filename}`, {
                method: 'POST',
                body: serialize({ parts }),
                signal,
            })

            if (!response.ok) throw new Error('Unsuccessful request', { cause: response })

            return response.json()
        },
    })

    const saveFileToDB = async (imagesData) => {
        // ... (sin cambios en esta función)
        if (!imagesData || imagesData.length === 0) throw new Error('imagesData is empty')
        try {
            const response = await fetchWithAuth(`${LARAVEL_PUBLIC_BACKEND_URL}/api/frame/contents/upload/public`, {
                method: 'POST',
                body: serialize({ images: imagesData, folder: uppy.getState().meta?.folder || '' }),
            })
            if (!response.ok) {
                alert('There was an error saving the images. Please contact support.')
            }
        } catch (error) {
            console.error('saveFileToDB', error)
            alert('There was an unexpected error saving the images. Please contact support.')
        }
    }

    uppy.on('upload-success', (file, response) => {
        // ... (sin cambios en esta función)
        if ((!file.uploadAwsUrl || file.uploadAwsUrl === 'undefined' || file.uploadAwsUrl === 'null') && response.uploadURL) {
            file.uploadAwsUrl = decodeURIComponent(response.uploadURL.split('?')[0])
        } else if (file.uploadURL && file.uploadURL !== 'undefined' && file.uploadURL !== 'null') {
            file.uploadAwsUrl = decodeURIComponent(file.uploadURL.split('?')[0])
        }

        if (!file.response) file.response = response
        
        // IMPORTANTE: Solo guardar en la DB el archivo original, no la miniatura
        if (file.meta.isThumbnail) {
            console.log('Thumbnail uploaded:', file.name);
            return; // No llamar a saveFileToDB para miniaturas
        }
        
        const imagesData = JSON.stringify([file])
        saveFileToDB(imagesData)
    })

    uppy.on('complete', (result) => {
        // ... (sin cambios en esta función)
        if (merged.callbackFn) merged.callbackFn(result)
    })

    return uppy
}

export default uppyModal