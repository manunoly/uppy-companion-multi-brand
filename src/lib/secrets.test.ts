import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    loadBrandSecrets,
    resetAwsBrandSecretsCacheForTests,
    resolveSecretsSource,
    warmAwsBrandSecretsCache,
    warmSecretsAtBootIfNeeded,
} from './secrets.js';

const smMock = mockClient(SecretsManagerClient);

beforeEach(() => {
    smMock.reset();
    resetAwsBrandSecretsCacheForTests();
});

afterEach(() => {
    smMock.reset();
    resetAwsBrandSecretsCacheForTests();
});

describe('resolveSecretsSource', () => {
    it('defaults to "env" when SECRETS_SOURCE is unset', () => {
        expect(resolveSecretsSource({})).toBe('env');
    });

    it('is case/whitespace-insensitive for "aws"', () => {
        expect(resolveSecretsSource({ SECRETS_SOURCE: ' AWS ' })).toBe('aws');
    });

    it('treats any other value as "env" (fail-safe default)', () => {
        expect(resolveSecretsSource({ SECRETS_SOURCE: 'gcp' })).toBe('env');
    });
});

describe('loadBrandSecrets: SECRETS_SOURCE=env (Railway, default)', () => {
    it('reads per-brand S3 credentials from env vars', () => {
        const secrets = loadBrandSecrets('edo', {
            env: { EDO_S3_ACCESS_KEY: 'AKIA_EDO', EDO_S3_SECRET_KEY: 'secret-edo' },
        });
        expect(secrets.s3.accessKey).toBe('AKIA_EDO');
        expect(secrets.s3.secretKey).toBe('secret-edo');
        // bucket/region fall back to the code-only base registry when unset.
        expect(secrets.s3.bucket).toBe('entourage-uploads');
        expect(secrets.s3.region).toBe('us-east-1');
    });

    it('lets a per-brand env var override the base registry bucket/region', () => {
        const secrets = loadBrandSecrets('edo', {
            env: {
                EDO_S3_ACCESS_KEY: 'a',
                EDO_S3_SECRET_KEY: 'b',
                EDO_S3_BUCKET: 'entourage-uploads-stage',
                EDO_S3_REGION: 'us-west-2',
                EDO_S3_ACCELERATE_ENDPOINT: 'true',
            },
        });
        expect(secrets.s3.bucket).toBe('entourage-uploads-stage');
        expect(secrets.s3.region).toBe('us-west-2');
        expect(secrets.s3.useAccelerateEndpoint).toBe(true);
    });

    it('falls back to global AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY when the per-brand vars are unset', () => {
        const secrets = loadBrandSecrets('edo', {
            env: { AWS_ACCESS_KEY_ID: 'global-key', AWS_SECRET_ACCESS_KEY: 'global-secret' },
        });
        expect(secrets.s3.accessKey).toBe('global-key');
        expect(secrets.s3.secretKey).toBe('global-secret');
    });

    it('reads per-brand OAuth provider credentials, only for providers with both key+secret set', () => {
        const secrets = loadBrandSecrets('edo', {
            env: {
                EDO_S3_ACCESS_KEY: 'a',
                EDO_S3_SECRET_KEY: 'b',
                EDO_DROPBOX_KEY: 'dbx-key',
                EDO_DROPBOX_SECRET: 'dbx-secret',
                EDO_FACEBOOK_KEY: 'fb-key',
                // no EDO_FACEBOOK_SECRET -> facebook must NOT be wired.
                EDO_GOOGLE_CLIENT_ID: 'google-client-id',
                EDO_GOOGLE_CLIENT_SECRET: 'google-client-secret',
                EDO_GOOGLE_DRIVE_API_KEY: 'drive-api-key',
            },
        });
        expect(secrets.providers.dropbox).toEqual({ key: 'dbx-key', secret: 'dbx-secret' });
        expect(secrets.providers.facebook).toBeUndefined();
        expect(secrets.providers.google).toEqual({
            clientId: 'google-client-id',
            clientSecret: 'google-client-secret',
            driveApiKey: 'drive-api-key',
            photosApiKey: undefined,
            appId: undefined,
        });
    });

    it('fails fast when S3 credentials are missing (Railway has no instance IAM role)', () => {
        expect(() => loadBrandSecrets('edo', { env: {} })).toThrow(/Missing required S3 credentials/);
    });

    it('fails fast when neither the env var nor the base registry provides a bucket/region', () => {
        // abe's base registry entry has an empty bucket (not servable yet) and no ABE_S3_* env vars set.
        expect(() => loadBrandSecrets('abe', { env: {} })).toThrow(/Missing required S3 bucket\/region/);
    });
});

describe('loadBrandSecrets: SECRETS_SOURCE=aws (Secrets Manager, optional)', () => {
    it('reads S3 + provider secrets from a mocked Secrets Manager after warming the cache', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({
                s3: { accessKey: 'sm-access', secretKey: 'sm-secret', bucket: 'sm-bucket', region: 'eu-west-1' },
                providers: { dropbox: { key: 'k', secret: 's' } },
            }),
        });

        await warmAwsBrandSecretsCache(['edo'], {});
        const secrets = loadBrandSecrets('edo', { env: { SECRETS_SOURCE: 'aws' } });

        expect(secrets.s3).toEqual({
            accessKey: 'sm-access',
            secretKey: 'sm-secret',
            bucket: 'sm-bucket',
            region: 'eu-west-1',
            useAccelerateEndpoint: undefined,
        });
        expect(secrets.providers.dropbox).toEqual({ key: 'k', secret: 's' });
    });

    it('falls back to the base registry bucket/region when the secret omits them', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({ s3: { accessKey: 'a', secretKey: 'b' } }),
        });

        await warmAwsBrandSecretsCache(['edo'], {});
        const secrets = loadBrandSecrets('edo', { env: { SECRETS_SOURCE: 'aws' } });

        expect(secrets.s3.bucket).toBe('entourage-uploads');
        expect(secrets.s3.region).toBe('us-east-1');
    });

    it('does NOT fail fast on missing S3 credentials (Default Credential Provider Chain applies to aws source)', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({}) });

        await warmAwsBrandSecretsCache(['edo'], {});
        const secrets = loadBrandSecrets('edo', { env: { SECRETS_SOURCE: 'aws' } });

        expect(secrets.s3.accessKey).toBeUndefined();
        expect(secrets.s3.secretKey).toBeUndefined();
        expect(secrets.s3.bucket).toBe('entourage-uploads');
    });

    it('still fails fast when no bucket/region is available from either the secret or the base registry', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({}) });

        await warmAwsBrandSecretsCache(['abe'], {});
        expect(() => loadBrandSecrets('abe', { env: { SECRETS_SOURCE: 'aws' } })).toThrow(
            /Missing required S3 bucket\/region/,
        );
    });

    it('fails fast (clear error) when the cache was never warmed for that brand', () => {
        expect(() => loadBrandSecrets('edo', { env: { SECRETS_SOURCE: 'aws' } })).toThrow(
            /No AWS Secrets Manager data cached/,
        );
    });

    it('fails fast when the Secrets Manager response has no SecretString', async () => {
        smMock.on(GetSecretValueCommand).resolves({});
        await expect(warmAwsBrandSecretsCache(['edo'], {})).rejects.toThrow(/has no SecretString/);
    });

    it('fails fast when the secret value is not valid JSON', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: 'not-json{' });
        await expect(warmAwsBrandSecretsCache(['edo'], {})).rejects.toThrow(/not valid JSON/);
    });

    it('fails fast when the SDK call itself rejects', async () => {
        smMock.on(GetSecretValueCommand).rejects(new Error('boom'));
        await expect(warmAwsBrandSecretsCache(['edo'], {})).rejects.toThrow(/Failed to fetch AWS Secrets Manager secret/);
    });

    it('uses a per-brand secret id override (<SLUG>_SECRETS_ID) when set', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ s3: { accessKey: 'a', secretKey: 'b' } }) });

        await warmAwsBrandSecretsCache(['edo'], { EDO_SECRETS_ID: 'custom/secret/id' });

        expect(smMock.commandCalls(GetSecretValueCommand)[0]?.args[0].input.SecretId).toBe('custom/secret/id');
    });
});

describe('warmSecretsAtBootIfNeeded', () => {
    it('does nothing (no Secrets Manager call) when SECRETS_SOURCE=env', async () => {
        await warmSecretsAtBootIfNeeded({ SECRETS_SOURCE: 'env' });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
    });

    it('warms the AWS cache for every servable slug when SECRETS_SOURCE=aws', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ s3: { accessKey: 'a', secretKey: 'b' } }) });

        await warmSecretsAtBootIfNeeded({ SECRETS_SOURCE: 'aws' });

        // Every servable slug (edo, abe — as of P1-C1) gets warmed at boot.
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
        expect(() => loadBrandSecrets('edo', { env: { SECRETS_SOURCE: 'aws' } })).not.toThrow();
    });
});
