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
    oauthDomain?: string;
    oauthProtocol?: 'http' | 'https';
    oauthPath?: string;
    apiKeyDrive?: string;
    apiKeyPhotos?: string;
    appId?: string;
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
    /**
     * Omit (do not set to '/') for a root-path deployment — @uppy/companion's
     * validateConfig throws on the literal string '/'
     * (github.com/transloadit/uppy/issues/4271; checked via `if (server?.path)`).
     */
    path?: string;
    /**
     * Allowlist for the OAuth `redirect_uri` handoff — Companion's
     * `oauth-redirect` controller only redirects to a host in this list
     * (`hasMatch(handlerHostName, options.server.validHosts)`). Derived from
     * `companionUrl`/`companionHosts` (Task 4.3, spec D9, closes H7).
     */
    validHosts?: string[];
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
    enableGooglePickerEndpoint?: boolean;
}
