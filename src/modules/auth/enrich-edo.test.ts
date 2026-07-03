import { describe, it, expect } from 'vitest';
import { enrichEdoUser } from './enrich-edo.js';
import type { BrandUser } from '../brand/brand.contract.js';

const baseUser: BrandUser = {
    id: '1004',
    email: 'manuel@entourageyearbooks.com',
    displayName: 'Manuel Almaguer',
    imageUrl: null,
};

describe('enrichEdoUser', () => {
    it('reads raw.edo_id (number) into user.edoId', () => {
        const raw = { id: 1004, edo_id: 854569, email: 'manuel@entourageyearbooks.com', name: 'Manuel Almaguer' };
        const enriched = enrichEdoUser(baseUser, raw);
        expect(enriched.edoId).toBe(854569);
    });

    it('leaves edoId undefined when raw.edo_id is absent or not a number', () => {
        expect(enrichEdoUser(baseUser, { id: 1004 }).edoId).toBeUndefined();
        expect(enrichEdoUser(baseUser, { edo_id: '854569' }).edoId).toBeUndefined();
        expect(enrichEdoUser(baseUser, null).edoId).toBeUndefined();
        expect(enrichEdoUser(baseUser, 'not-an-object').edoId).toBeUndefined();
    });

    it('splits a "<username>::<email>" composite email into the real email', () => {
        const composite: BrandUser = { ...baseUser, email: 'mAlmaguer::manuel@entourageyearbooks.com' };
        const enriched = enrichEdoUser(composite, { edo_id: 1 });
        expect(enriched.email).toBe('manuel@entourageyearbooks.com');
    });

    it('leaves a plain email (no "::") untouched', () => {
        const enriched = enrichEdoUser(baseUser, { edo_id: 1 });
        expect(enriched.email).toBe('manuel@entourageyearbooks.com');
    });

    it('uses the raw email verbatim when the "::" suffix is empty', () => {
        const composite: BrandUser = { ...baseUser, email: 'mAlmaguer::' };
        const enriched = enrichEdoUser(composite, { edo_id: 1 });
        expect(enriched.email).toBe('mAlmaguer::');
    });

    it('preserves every other BrandUser field unchanged', () => {
        const enriched = enrichEdoUser(baseUser, { edo_id: 854569 });
        expect(enriched.id).toBe(baseUser.id);
        expect(enriched.displayName).toBe(baseUser.displayName);
        expect(enriched.imageUrl).toBe(baseUser.imageUrl);
    });
});
