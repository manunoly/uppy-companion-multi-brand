/**
 * Brand configuration types.
 *
 * Historically this file defined the Companion's own `BrandConfigJSON`/`Brand`
 * shape (auth.url/cookieName, public.backendUrl/uploadUrl, CSV enabledPlugins...).
 * Task 2.7 of the abeduls3-alignment plan (atomic cutover) retires that legacy
 * model in favor of the contract reimplemented 1:1 from abeduls3's
 * `@package/brands` — see `brand.contract.ts`. Every consumer that used to
 * import `Brand`/`BrandRegistry`/etc. from here keeps working unchanged
 * (same file path), now backed by the new shape.
 */
export * from './brand.contract.js';
