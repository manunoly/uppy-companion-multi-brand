import { describe, it, expect } from 'vitest';
import { parseDeclaredLength } from './s3.controller.js';

// Copilot (PR #7) flagged that parseDeclaredLength accepted any finite number,
// including negatives/fractions, which then slipped past the `> maxUploadBytes`
// limit check. A client-declared Content-Length must be a positive integer;
// anything else is treated as "not declared" (undefined) so the check stays
// consistent.
describe('parseDeclaredLength', () => {
    it('parses a positive integer byte count', () => {
        expect(parseDeclaredLength('123')).toBe(123);
        expect(parseDeclaredLength(456)).toBe(456);
    });

    it('treats malformed byte counts as undefined (negative, fractional, zero, non-numeric, non-finite)', () => {
        for (const raw of ['-1', '1.5', '0', '-0', 'abc', 'NaN', 'Infinity', '1e999', ' ']) {
            expect(parseDeclaredLength(raw)).toBeUndefined();
        }
    });

    it('treats absent values as undefined', () => {
        expect(parseDeclaredLength(undefined)).toBeUndefined();
        expect(parseDeclaredLength(null)).toBeUndefined();
        expect(parseDeclaredLength('')).toBeUndefined();
    });
});
