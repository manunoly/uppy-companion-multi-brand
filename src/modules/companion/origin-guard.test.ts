import { describe, it, expect } from 'vitest';
import { resolveAllowedTargetOrigin } from './origin-guard.js';

/**
 * Pure postMessage target guard — the canonical, Node-testable implementation
 * that uppyModal.ts and uppy.routes.ts's auth-required page mirror inline
 * (they cannot import it; see origin-guard.ts's doc comment). Every caller
 * MUST treat `null` as "abort the postMessage", never fall back to `'*'`.
 */

const ALLOWED = ['https://designer.abeduls.com', 'https://designer.abeduls.local'] as const;

describe('resolveAllowedTargetOrigin', () => {
    it('returns the origin when the referrer matches an allow-listed origin', () => {
        expect(resolveAllowedTargetOrigin('https://designer.abeduls.com/some/page?x=1', ALLOWED)).toBe(
            'https://designer.abeduls.com',
        );
    });

    it('matches exactly the intended entry among several allow-listed origins', () => {
        expect(resolveAllowedTargetOrigin('https://designer.abeduls.local/x', ALLOWED)).toBe(
            'https://designer.abeduls.local',
        );
    });

    it('returns null for a foreign (non-allow-listed) origin', () => {
        expect(resolveAllowedTargetOrigin('https://evil.example.com/', ALLOWED)).toBeNull();
    });

    it('returns null when the referrer is absent (undefined, null, or empty string)', () => {
        expect(resolveAllowedTargetOrigin(undefined, ALLOWED)).toBeNull();
        expect(resolveAllowedTargetOrigin(null, ALLOWED)).toBeNull();
        expect(resolveAllowedTargetOrigin('', ALLOWED)).toBeNull();
    });

    it('returns null for a malformed referrer URL', () => {
        expect(resolveAllowedTargetOrigin('not-a-url', ALLOWED)).toBeNull();
    });

    it('returns null when the allow-list is empty', () => {
        expect(resolveAllowedTargetOrigin('https://designer.abeduls.com/', [])).toBeNull();
    });

    it('rejects a port mismatch against an otherwise-matching host (exact origin, not host-only)', () => {
        expect(resolveAllowedTargetOrigin('https://designer.abeduls.com:8443/', ALLOWED)).toBeNull();
    });

    it('rejects a scheme mismatch (http vs https)', () => {
        expect(resolveAllowedTargetOrigin('http://designer.abeduls.com/', ALLOWED)).toBeNull();
    });

    it('rejects a subdomain that was not itself allow-listed (no suffix matching for postMessage targets)', () => {
        expect(resolveAllowedTargetOrigin('https://evil.designer.abeduls.com/', ALLOWED)).toBeNull();
    });

    it('never returns the wildcard "*", for any input', () => {
        const inputs: Array<string | null | undefined> = [
            undefined,
            null,
            '',
            'not-a-url',
            'https://evil.example.com',
            'https://designer.abeduls.com',
            '*',
            'https://designer.abeduls.com/*',
        ];
        for (const referrer of inputs) {
            expect(resolveAllowedTargetOrigin(referrer, ALLOWED)).not.toBe('*');
        }
    });
});
