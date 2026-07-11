/**
 * Pure postMessage target-origin guard. Given the embedding page's referrer
 * and the brand's allow-listed embed origins (`brand.domains` -> `https://<host>`,
 * see core/csp.ts#brandEmbedOrigins), returns the exact origin to hand to
 * `window.parent.postMessage(msg, targetOrigin)`, or `null` when the referrer
 * is absent/malformed or not on the allow-list.
 *
 * NEVER returns `'*'`: callers MUST abort the postMessage when this returns
 * `null` rather than falling back to a wildcard target (which would leak the
 * message to any embedding origin).
 *
 * This is the canonical, unit-tested implementation. uppyModal.ts (the Uppy
 * bundle) and the server-rendered auth-required page carry a byte-identical
 * inline mirror because the asset build uses esbuild `transform`, not `bundle`
 * (scripts/build-assets.mjs) — a browser file cannot `import` this module.
 */
export function resolveAllowedTargetOrigin(
    referrer: string | null | undefined,
    allowedOrigins: readonly string[],
): string | null {
    if (!referrer) return null;
    let origin: string;
    try {
        origin = new URL(referrer).origin;
    } catch {
        return null;
    }
    return allowedOrigins.includes(origin) ? origin : null;
}
