import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanionBrandConfig } from './brand.contract.js';
import { readIngestToken, resolveValidatedIngestTarget } from './identity.js';
import { getBaseBrandConfig } from './registry.js';

/**
 * P1-C3: the ingest-callback seam (`ingest?: { url, tokenEnv }`) — resolution
 * (`resolveValidatedIngestTarget`) and token read (`readIngestToken`). Mirrors
 * identity.test.ts's `resolveValidatedWhoamiTarget`/`validateWhoamiUrl` suite
 * since `resolveValidatedIngestTarget` reuses the same SSRF gate.
 */

const abe = getBaseBrandConfig('abe');
const edo = getBaseBrandConfig('edo');

function withIngestUrl(url: string): CompanionBrandConfig {
    return { ...abe, ingest: { url, tokenEnv: 'ABE_INGEST_TOKEN' } };
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('resolveValidatedIngestTarget', () => {
    it("returns ok:true for abe's real registry entry (host www.abeduls.com)", () => {
        const result = resolveValidatedIngestTarget(abe);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.url.hostname).toBe('www.abeduls.com');
            expect(result.url.href).toBe('https://www.abeduls.com/api/internal/media/ingest');
        }
    });

    it('returns ok:false and does not throw when ingest is absent (edo)', () => {
        expect(() => resolveValidatedIngestTarget(edo)).not.toThrow();
        const result = resolveValidatedIngestTarget(edo);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('not configured');
    });

    it('returns ok:false for a host not in whoamiAllowedHosts (SSRF gate)', () => {
        const result = resolveValidatedIngestTarget(withIngestUrl('https://evil.com/api/internal/media/ingest'));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('ingest.url: host not allowed');
    });

    it('returns ok:false for a non-https ingest.url', () => {
        const result = resolveValidatedIngestTarget(withIngestUrl('http://abeduls.com/api/internal/media/ingest'));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('ingest.url: non-https');
    });

    it('returns ok:false for an ingest.url carrying credentials', () => {
        const result = resolveValidatedIngestTarget(withIngestUrl('https://user:pass@abeduls.com/api/internal/media/ingest'));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('ingest.url: credentials');
    });

    it('returns ok:false for an ingest.url on a non-default port', () => {
        const result = resolveValidatedIngestTarget(withIngestUrl('https://abeduls.com:8443/api/internal/media/ingest'));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('ingest.url: non-default port');
    });
});

describe('readIngestToken', () => {
    it('returns the token value when the env var is set', () => {
        vi.stubEnv('ABE_INGEST_TOKEN', 'secret-token-value');
        expect(readIngestToken('ABE_INGEST_TOKEN')).toBe('secret-token-value');
    });

    it('throws when the env var is unset', () => {
        vi.stubEnv('ABE_INGEST_TOKEN', undefined);
        expect(() => readIngestToken('ABE_INGEST_TOKEN')).toThrow(/ABE_INGEST_TOKEN.*empty/);
    });

    it('throws when the env var is an empty string', () => {
        vi.stubEnv('ABE_INGEST_TOKEN', '');
        expect(() => readIngestToken('ABE_INGEST_TOKEN')).toThrow(/ABE_INGEST_TOKEN.*empty/);
    });

    it('throws when the env var is whitespace-only', () => {
        vi.stubEnv('ABE_INGEST_TOKEN', '   ');
        expect(() => readIngestToken('ABE_INGEST_TOKEN')).toThrow(/ABE_INGEST_TOKEN.*empty/);
    });
});
