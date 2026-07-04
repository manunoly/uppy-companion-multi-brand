import { describe, expect, it } from 'vitest';
import { BRAND_SLUGS, BRAND_SLUG_VALUES, isBrandSlug } from './slugs.js';

describe('brand slugs', () => {
    it('defines exactly the three known brands', () => {
        expect(BRAND_SLUG_VALUES).toEqual(['abe', 'picaboo', 'edo']);
        expect(Object.values(BRAND_SLUGS)).toEqual(['abe', 'picaboo', 'edo']);
    });

    it('isBrandSlug narrows valid slugs and rejects everything else', () => {
        expect(isBrandSlug('abe')).toBe(true);
        expect(isBrandSlug('picaboo')).toBe(true);
        expect(isBrandSlug('edo')).toBe(true);
        expect(isBrandSlug('capsule')).toBe(false);
        expect(isBrandSlug('designer')).toBe(false);
        expect(isBrandSlug('')).toBe(false);
        expect(isBrandSlug('ABE')).toBe(false);
    });
});
