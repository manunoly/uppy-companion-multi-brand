import { describe, it, expect } from 'vitest';
import { normalizeBrandSlug } from './brand.utils.js';

describe('normalizeBrandSlug', () => {
    it('lowercases mixed case', () => {
        expect(normalizeBrandSlug('Acme')).toBe('acme');
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeBrandSlug('  brand-x  ')).toBe('brand-x');
    });

    it('collapses non-alphanumeric chars to dashes', () => {
        expect(normalizeBrandSlug('Brand_X!')).toBe('brand-x-');
    });

    it('returns empty string for empty input', () => {
        expect(normalizeBrandSlug('')).toBe('');
    });

    it('returns empty string for null/undefined', () => {
        expect(normalizeBrandSlug(null)).toBe('');
        expect(normalizeBrandSlug(undefined)).toBe('');
    });

    it('preserves dashes and digits', () => {
        expect(normalizeBrandSlug('brand-123')).toBe('brand-123');
    });

    it('replaces spaces with dashes', () => {
        expect(normalizeBrandSlug('Hello World')).toBe('hello-world');
    });
});
