import type { BrandUser } from '../brand/brand.contract.js';

/**
 * edo-only enrichment applied AFTER `normalizeBrandUser` (session-resolver.ts,
 * step 9, gated on `slug === 'edo'`). Ported from abeduls3's
 * `apps/designer/lib/auth/brandResolver.ts:161-199` (`readEdoExtras` +
 * `parseEdoEmail` + `enrichEdoUser`), narrowed to the single extra field the
 * Companion's `BrandUser` carries: `edoId` (spec SA1 — metadata/listing only,
 * NEVER used for S3 keys, see s3.key-builder.ts). The designer's much larger
 * `readEdoExtras` also lifts `brandId`/`cspId`/`firstName`/`status`/... onto
 * its own `User` type; the Companion has no use for those, so only `edo_id`
 * is read here.
 */

/**
 * edo emails may carry a "<username>::<realEmail>" prefix (business rule).
 * The real email is the part after "::"; a value with no "::" (or an empty
 * suffix) is used verbatim.
 */
function parseEdoEmail(rawEmail: string): string {
    const i = rawEmail.indexOf('::');
    if (i === -1) return rawEmail;
    const realEmail = rawEmail.slice(i + 2);
    return realEmail.length === 0 ? rawEmail : realEmail;
}

function readEdoId(raw: unknown): number | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const edoId = (raw as Record<string, unknown>).edo_id;
    return typeof edoId === 'number' ? edoId : undefined;
}

/**
 * Enriches an already-`normalizeBrandUser`-validated `BrandUser` with edo-only
 * extras. Only ever called for `slug === 'edo'` (session-resolver.ts) — the
 * `edo_id` field belongs to edonext's whoami response shape specifically.
 */
export function enrichEdoUser(user: BrandUser, raw: unknown): BrandUser {
    const email = parseEdoEmail(user.email);
    const edoId = readEdoId(raw);
    return edoId === undefined ? { ...user, email } : { ...user, email, edoId };
}
