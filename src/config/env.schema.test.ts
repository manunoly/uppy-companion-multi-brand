import { describe, it, expect } from 'vitest';
import { envSchema } from './env.schema.js';
import { makeValidEnv } from '../test-utils/env-fixtures.js';

describe('envSchema', () => {
    it('parses a fully-populated valid env', () => {
        const result = envSchema.safeParse(makeValidEnv());
        expect(result.success).toBe(true);
    });

    it('requires secret of >= 16 chars', () => {
        const result = envSchema.safeParse({
            ...makeValidEnv(),
            secret: 'short',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some(i => i.path.includes('secret'))).toBe(true);
        }
    });

    it('requires publicHost', () => {
        const env: Record<string, unknown> = { ...makeValidEnv() };
        delete env.publicHost;
        const result = envSchema.safeParse(env);
        expect(result.success).toBe(false);
    });

    it('rejects protocol values other than http/https', () => {
        const result = envSchema.safeParse({
            ...makeValidEnv(),
            protocol: 'ftp',
        });
        expect(result.success).toBe(false);
    });

    it('defaults port to 3020 when omitted', () => {
        const env: Record<string, unknown> = { ...makeValidEnv() };
        delete env.port;
        const result = envSchema.safeParse(env);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.port).toBe(3020);
    });

    it('defaults redisUrl to a local dev instance when omitted', () => {
        const env: Record<string, unknown> = { ...makeValidEnv() };
        delete env.redisUrl;
        const result = envSchema.safeParse(env);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.redisUrl).toBe('redis://localhost:6379');
    });

    it('defaults filePath to "/tmp/" when omitted', () => {
        const env: Record<string, unknown> = { ...makeValidEnv() };
        delete env.filePath;
        const result = envSchema.safeParse(env);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.filePath).toBe('/tmp/');
    });

    it('healthCheckKey is optional', () => {
        const result = envSchema.safeParse(makeValidEnv({ healthCheckKey: undefined }));
        expect(result.success).toBe(true);
    });

    it('defaults rateLimitWindowMs to 60000ms when omitted', () => {
        const env: Record<string, unknown> = { ...makeValidEnv() };
        delete env.rateLimitWindowMs;
        const result = envSchema.safeParse(env);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.rateLimitWindowMs).toBe(60_000);
    });

    it('defaults rateLimitMax to 300 when omitted', () => {
        const env: Record<string, unknown> = { ...makeValidEnv() };
        delete env.rateLimitMax;
        const result = envSchema.safeParse(env);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.rateLimitMax).toBe(300);
    });
});
