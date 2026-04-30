import { describe, it, expect } from 'vitest';
import { brandConfigSchema } from './brand.schema.js';

describe('brandConfigSchema', () => {
    it('accepts an empty config', () => {
        const result = brandConfigSchema.safeParse({});
        expect(result.success).toBe(true);
    });

    it('accepts displayName + rootDomain + nested auth.url', () => {
        const result = brandConfigSchema.safeParse({
            displayName: 'Acme',
            rootDomain: 'acme.example.com',
            auth: { url: 'https://api.acme.example.com/me' },
        });
        expect(result.success).toBe(true);
    });

    it('rejects auth.url without rootDomain (cookie auth invariant)', () => {
        const result = brandConfigSchema.safeParse({
            auth: { url: 'https://api.acme.example.com/me' },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some(i =>
                i.path.includes('rootDomain') &&
                i.message.includes('rootDomain is required when auth.url is configured')
            )).toBe(true);
        }
    });

    it('rejects legacy authUrl without rootDomain', () => {
        const result = brandConfigSchema.safeParse({
            authUrl: 'https://api.acme.example.com/me',
        });
        expect(result.success).toBe(false);
    });

    it('accepts legacy authUrl when rootDomain is also set', () => {
        const result = brandConfigSchema.safeParse({
            authUrl: 'https://api.acme.example.com/me',
            rootDomain: 'acme.example.com',
        });
        expect(result.success).toBe(true);
    });

    it('rejects rootDomain without a TLD', () => {
        const result = brandConfigSchema.safeParse({ rootDomain: 'localhost' });
        expect(result.success).toBe(false);
    });

    it('rejects rootDomain with scheme', () => {
        const result = brandConfigSchema.safeParse({ rootDomain: 'https://acme.example.com' });
        expect(result.success).toBe(false);
    });

    it('accepts public.loginUrl when it is a valid URL', () => {
        const result = brandConfigSchema.safeParse({
            rootDomain: 'acme.example.com',
            auth: { url: 'https://api.acme.example.com/me' },
            public: { loginUrl: 'https://app.acme.example.com/login' },
        });
        expect(result.success).toBe(true);
    });

    it('rejects public.loginUrl that is not a URL', () => {
        const result = brandConfigSchema.safeParse({
            rootDomain: 'acme.example.com',
            auth: { url: 'https://api.acme.example.com/me' },
            public: { loginUrl: 'not-a-url' },
        });
        expect(result.success).toBe(false);
    });

    it('rejects unknown top-level keys (strict mode)', () => {
        const result = brandConfigSchema.safeParse({
            unknownField: 'oops',
        });
        expect(result.success).toBe(false);
    });

    it('transforms google legacy aliases (key/secret/apiKey) to preferred names', () => {
        const result = brandConfigSchema.safeParse({
            providers: {
                google: { key: 'cid', secret: 'csec', apiKey: 'apik' },
            },
        });
        expect(result.success).toBe(true);
        if (result.success && result.data.providers?.google) {
            expect(result.data.providers.google.clientId).toBe('cid');
            expect(result.data.providers.google.clientSecret).toBe('csec');
            expect(result.data.providers.google.driveApiKey).toBe('apik');
            expect(result.data.providers.google.photosApiKey).toBe('apik');
        }
    });

    it('preferred google keys win over legacy', () => {
        const result = brandConfigSchema.safeParse({
            providers: {
                google: { clientId: 'preferred-cid', key: 'legacy-cid' },
            },
        });
        expect(result.success).toBe(true);
        if (result.success && result.data.providers?.google) {
            expect(result.data.providers.google.clientId).toBe('preferred-cid');
        }
    });

    it('accepts s3 with all fields optional', () => {
        const r1 = brandConfigSchema.safeParse({ s3: {} });
        expect(r1.success).toBe(true);
        const r2 = brandConfigSchema.safeParse({
            s3: { bucket: 'b', region: 'us-east-1', useAccelerateEndpoint: true },
        });
        expect(r2.success).toBe(true);
    });
});
