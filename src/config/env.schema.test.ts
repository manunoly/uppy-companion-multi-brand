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

    it('defaults brands to "default" when omitted', () => {
        const env: Record<string, unknown> = { ...makeValidEnv() };
        delete env.brands;
        const result = envSchema.safeParse(env);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.brands).toBe('default');
    });

    it('defaults port to 3020 when omitted', () => {
        const env: Record<string, unknown> = { ...makeValidEnv() };
        delete env.port;
        const result = envSchema.safeParse(env);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.port).toBe(3020);
    });

    it('healthCheckKey is optional', () => {
        const result = envSchema.safeParse(makeValidEnv({ healthCheckKey: undefined }));
        expect(result.success).toBe(true);
    });

    it('rejects unknown brand JSON config (delegates to brandConfigSchema)', () => {
        const result = envSchema.safeParse({
            ...makeValidEnv(),
            brandConfigs: { foo: { unknownField: 'x' } },
        });
        expect(result.success).toBe(false);
    });

    it('accepts brandConfigs with valid brand JSON', () => {
        const result = envSchema.safeParse({
            ...makeValidEnv(),
            brandConfigs: {
                foo: {
                    rootDomain: 'foo.example.com',
                    auth: { url: 'https://api.foo.example.com' },
                },
            },
        });
        expect(result.success).toBe(true);
    });
});
