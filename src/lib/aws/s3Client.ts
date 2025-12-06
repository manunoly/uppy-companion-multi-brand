import { S3Client, GetObjectCommand, PutObjectCommand, S3ClientConfig } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";

// Variable local para almacenar la instancia única (Singleton)
let s3ClientInstance: S3Client | null = null;

/**
 * Obtiene la instancia única del cliente S3.
 * Implementa "Lazy Loading": solo se crea la primera vez que se necesita.
 */
export function getS3Client({ regionParam, accessKeyIdParam, secretAccessKeyParam }: { regionParam?: string; accessKeyIdParam?: string; secretAccessKeyParam?: string } = {}): S3Client {
    const hasExplicitConfig = regionParam || accessKeyIdParam || secretAccessKeyParam;

    // Si no hay configuración explícita, intentamos usar el Singleton
    if (!hasExplicitConfig && s3ClientInstance) {
        return s3ClientInstance;
    }

    // 1. Configuración base
    const region = regionParam || process.env.AWS_REGION || "us-east-1";

    const config: S3ClientConfig = {
        region,
        // Optimizaciones para entornos de servidor (Fargate/Lambda)
        maxAttempts: 3,
    };

    // 2. Lógica de Autenticación Híbrida
    // Si existen las variables explícitas, las usamos.
    // Si NO existen, no pasamos nada y el SDK utilizará automáticamente 
    // la "Default Credential Provider Chain" (que busca el IAM Task Role en Fargate/ECS).
    const accessKeyId = accessKeyIdParam || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = secretAccessKeyParam || process.env.AWS_SECRET_ACCESS_KEY;

    if (accessKeyId && secretAccessKey) {
        // Solo loguear si estamos usando el singleton/default para evitar spam en logs por request
        if (!hasExplicitConfig) {
            console.log("🔐 [S3] Usando credenciales explícitas (.env)");
        }
        config.credentials = {
            accessKeyId,
            secretAccessKey
        };
    } else if (!hasExplicitConfig) {
        console.log("🛡️ [S3] Usando IAM Task Role (Default Provider Chain)");
    }

    // 3. Crear instancia
    const client = new S3Client(config);

    // Solo guardamos en singleton si es la configuración por defecto
    if (!hasExplicitConfig) {
        s3ClientInstance = client;
    }

    return client;
}

/**
 * Helper reutilizable para subir archivos (Buffer o Stream)
 */
export async function uploadFile(bucket: string, key: string, body: Buffer | Uint8Array | Readable | string, contentType: string = 'application/octet-stream') {
    const client = getS3Client();
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType
    });

    return await client.send(command);
}

/**
 * Helper reutilizable para descargar archivos como Buffer
 */
export async function downloadFileAsBuffer(bucket: string, key: string): Promise<Buffer> {
    const client = getS3Client();
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    });

    const response = await client.send(command);

    if (!response.Body) {
        throw new Error(`El archivo ${key} en ${bucket} está vacío.`);
    }

    // Convertir el stream de S3 a Buffer (Node 22/SDK v3 helper)
    return Buffer.from(await response.Body.transformToByteArray());
}

/**
 * Genera una URL firmada para acceder a un objeto privado de S3 por un tiempo limitado.
 * @param bucket Nombre del bucket
 * @param key Ruta del archivo (Key)
 * @param expiresIn Tiempo de expiración en segundos (default: 7 días)
 */
export async function generateSignedUrl(bucket: string, key: string, expiresIn: number = 604800): Promise<string> {
    const client = getS3Client();
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    });

    return await getSignedUrl(client, command, { expiresIn });
}