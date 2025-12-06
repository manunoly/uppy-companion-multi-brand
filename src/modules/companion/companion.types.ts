/**
 * Companion module types
 */

import type { Request } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';

export interface AwsGetKeyParams {
    filename: string;
    metadata?: Record<string, unknown>;
    req: Request;
}

export interface CompanionProviderOptions {
    key: string;
    secret: string;
}

export interface CompanionS3Options {
    key?: string;
    secret?: string;
    bucket: string;
    region: string;
    useAccelerateEndpoint?: boolean;
    awsClient?: S3Client;
    getKey: (req: Request, filename: string, metadata?: Record<string, unknown>) => string;
}

export interface CompanionServerOptions {
    host: string;
    protocol: 'http' | 'https';
    path: string;
}

export interface CompanionOptions {
    providerOptions?: Record<string, CompanionProviderOptions>;
    server: CompanionServerOptions;
    filePath: string;
    secret: string;
    uploadUrls: string[];
    corsOrigins: (string | RegExp)[];
    s3?: CompanionS3Options;
    metrics?: boolean;
    allowLocalUrls?: boolean;
}
