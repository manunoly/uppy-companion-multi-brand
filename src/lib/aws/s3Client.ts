import { S3Client, GetObjectCommand, PutObjectCommand, S3ClientConfig } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";

let s3ClientInstance: S3Client | null = null;

/**
 * Returns the singleton S3 client, lazy-instantiated on first call.
 * When called with explicit credentials, returns a fresh client without caching.
 */
export function getS3Client({ regionParam, accessKeyIdParam, secretAccessKeyParam }: { regionParam?: string; accessKeyIdParam?: string; secretAccessKeyParam?: string } = {}): S3Client {
    const hasExplicitConfig = regionParam || accessKeyIdParam || secretAccessKeyParam;

    if (!hasExplicitConfig && s3ClientInstance) {
        return s3ClientInstance;
    }

    const region = regionParam || process.env.AWS_REGION || "us-east-1";

    const config: S3ClientConfig = {
        region,
        // Server-side retry policy tuned for Fargate/Lambda.
        maxAttempts: 3,
    };

    const accessKeyId = accessKeyIdParam || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = secretAccessKeyParam || process.env.AWS_SECRET_ACCESS_KEY;

    // When explicit keys are absent, the AWS SDK falls back to the Default
    // Credential Provider Chain (e.g. IAM Task Role on Fargate/ECS).
    if (accessKeyId && secretAccessKey) {
        // Only log on singleton init to avoid per-request log spam.
        if (!hasExplicitConfig) {
            console.log("[S3] Using explicit credentials (.env)");
        }
        config.credentials = {
            accessKeyId,
            secretAccessKey
        };
    } else if (!hasExplicitConfig) {
        console.log("[S3] Using IAM Task Role (Default Provider Chain)");
    }

    const client = new S3Client(config);

    if (!hasExplicitConfig) {
        s3ClientInstance = client;
    }

    return client;
}

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

export async function downloadFileAsBuffer(bucket: string, key: string): Promise<Buffer> {
    const client = getS3Client();
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    });

    const response = await client.send(command);

    if (!response.Body) {
        throw new Error(`Empty object ${key} in bucket ${bucket}`);
    }

    return Buffer.from(await response.Body.transformToByteArray());
}

/**
 * Generates a presigned URL for time-limited access to a private S3 object.
 * @param expiresIn Expiration in seconds (default: 7 days).
 */
export async function generateSignedUrl(bucket: string, key: string, expiresIn: number = 604800): Promise<string> {
    const client = getS3Client();
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    });

    return await getSignedUrl(client, command, { expiresIn });
}
