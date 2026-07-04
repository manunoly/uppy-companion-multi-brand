/**
 * Canonical brand slugs. Ported 1:1 from abeduls3's `packages/brands/src/slugs.ts`
 * so the Companion speaks the same brand vocabulary as its main client.
 */
export const BRAND_SLUGS = {
    ABEDULS: 'abe',
    PICABOO: 'picaboo',
    ENTOURAGE: 'edo',
} as const;

export type BrandSlug = (typeof BRAND_SLUGS)[keyof typeof BRAND_SLUGS];

export const BRAND_SLUG_VALUES = ['abe', 'picaboo', 'edo'] as const satisfies readonly BrandSlug[];

export function isBrandSlug(value: string): value is BrandSlug {
    return (BRAND_SLUG_VALUES as readonly string[]).includes(value);
}
