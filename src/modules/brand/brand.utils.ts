/**
 * Normalizes a brand slug to lowercase alphanumeric with dashes.
 */
export const normalizeBrandSlug = (value: string | undefined | null): string => {
    return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
};
