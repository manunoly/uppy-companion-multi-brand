# Uppy iframe loading-speed implementation plan

**Goal:** Remove avoidable third-party work from `/uppy`, serve the Uppy client
from the Companion origin, and give the resulting assets production-grade
compression and cache invalidation without changing upload behavior.

## Audit findings and decisions

The original direction was sound but several details needed correction before
implementation:

- HTTP caches are partitioned by top-level site and current-frame site. Moving
  an asset from `releases.transloadit.com` to the iframe's own origin does **not**
  make a cache entry from direct navigation reusable in a cross-site iframe.
  It does remove a separate third-party DNS/TCP/TLS connection, removes CDN CSP
  allowances, and gives this service control over compression and caching. The
  performance claim is therefore "remove the avoidable third-party critical
  path and make repeat iframe loads cacheable within their partition," not a
  guarantee that direct and framed cache states become identical. See Chrome's
  cache-partitioning description:
  https://developer.chrome.com/blog/http-cache-partitioning/
- The preconnect level was useful only as an independently deployed interim
  patch. This execution delivers self-hosting end-to-end, so adding and then
  removing the hint is needless churn. It is omitted.
- Registry versions were rechecked with `pnpm view <package> version` on
  2026-07-12. The package names and proposed majors are current: Uppy packages
  are not all on the same major.
- esbuild does emit a sibling CSS bundle for CSS imported by a bundled JS entry
  point. The HTML must link that output itself. See:
  https://esbuild.github.io/content-types/#import-from-javascript
- Official Uppy docs require Core and Dashboard CSS and state that URL plugin
  styles are not included in Dashboard styles. The bundle must therefore import
  `@uppy/url/css/style.min.css` in addition to Core, Dashboard, and Image Editor
  CSS. See: https://uppy.io/docs/dashboard/
- The existing `src/server.integration.test.ts` has CDN/SRI and CSP assertions.
  They are part of this change; limiting updates to `csp.test.ts` and
  `uppy.routes.test.ts` would leave the suite red.
- A large self-hosted JS bundle served by Express without compression can be
  slower than the CDN asset. The asset routes will use Express compression.
- Long-lived caching on stable filenames is unsafe across deployments. The build
  injects a content-derived version into the JS/CSS query strings. Production
  responses can then use `max-age=31536000, immutable`; dev fallback responses
  remain `no-store`.
- The client packages remain `devDependencies`: the builder needs them, while the
  production image serves already-built files and installs production packages
  only. `compression` is a production dependency because it runs in Express.
- The current brand plugin contract is the extensibility boundary. The bundle
  retains all plugins already supported by `uppyModal.ts`; adding a future
  plugin still requires extending the typed contract, importing its package and
  CSS if applicable, and adding its registration branch. No brand slug or host
  is hardcoded into the asset pipeline.

No step in this plan creates a commit, stages files, changes branches, or touches
remotes.

## Task 1: Establish the failing end-state tests

- Update `src/core/csp.test.ts` to require no Transloadit/cdnjs source while
  preserving the conditional Google script source.
- Update `src/server.integration.test.ts` to replace the obsolete SRI assertions
  with assertions that `/uppy` references versioned same-origin assets and that
  CSP contains neither retired CDN.
- Add route tests proving rendered HTML has no SweetAlert2, cdnjs, Transloadit,
  or `nomodule`, links `/uppy.css?v=...`, and imports
  `/uppyModal.js?v=...` without leaving an asset-version placeholder.
- Run the focused tests and record the expected failures before implementation.

## Task 2: Remove third-party dead weight and retire CDN CSP entries

- Remove SweetAlert2 CSS/JS, the Uppy CDN stylesheet, and the obsolete CDN
  `nomodule` script from `src/modules/companion/uppy.html`.
- Add same-origin versioned CSS/JS references. Keep the existing nonce on the
  inline module script.
- Remove `CDNJS_ORIGIN` and `TRANSLOADIT_ORIGIN` from `src/core/csp.ts`.
  `script-src` remains self + per-request nonce + Google loader only for brands
  using a Google picker. `style-src` remains self + unsafe-inline because Uppy
  uses inline styles at runtime.
- Run focused CSP, route, and server integration tests.

## Task 3: Install and wire the Uppy npm packages

- Add the 17 client packages at their registry-verified compatible versions to
  `devDependencies` and add `compression`/`@types/compression` in their correct
  dependency classes. Run `pnpm install` only.
- Verify package exports and CSS files from the installed tree, including URL
  CSS.
- Change `uppyModal.ts` from the CDN aggregate import to package default imports.
  Add side-effect CSS imports for Core, Dashboard, URL, and Image Editor.
- Replace the aggregate CDN Vitest mock with per-package default-export mocks and
  CSS mocks. Do not change the module's public behavior or remove
  `// @ts-nocheck`.
- Run `src/modules/companion/uppyModal.test.ts` before and after the import change.

## Task 4: Bundle production and development assets

- Replace `esbuild.transform` in `scripts/build-assets.mjs` with
  `esbuild.build({ bundle: true, platform: 'browser', format: 'esm',
  target: 'es2020', minify: true })`.
- Generate `uppyModal.js` and `uppyModal.css`, compute a short SHA-256 version
  from both files, and inject it into the copied production `uppy.html`.
- Keep sourcemaps disabled for the public production assets.
- Replace the dev transpile fallback with a memoized `write:false` esbuild bundle
  that returns both JS and CSS. Cache by source text, serve dev assets with
  `Cache-Control: no-store`, and fail clearly if either expected output is absent.
- Add `serveUppyCss`, mount `/uppy.css`, and apply one shared compression
  middleware instance to the JS and CSS routes only.
- Serve prebuilt assets with
  `Cache-Control: public, max-age=31536000, immutable` only when the request
  carries the `?v=` version; the versioned HTML URLs provide invalidation.
  Unversioned requests keep the previous short `max-age=300` — with query-string
  versioning the bare URL stays valid (unlike hashed filenames), and immutable
  there would pin any unversioned consumer to a stale bundle for a year with no
  server-side remedy. (Second-audit correction.)
- Add real-filesystem Vitest coverage for the dev JS/CSS bundle output and focused
  integration coverage for the asset routes and compression.
- Run the focused tests and `pnpm build`. Verify the built JS has no bare
  `@uppy/*` imports, built CSS contains `.uppy-Dashboard`, built HTML contains no
  retired CDN or placeholder, and the asset version changes when bundle content
  changes by construction (hash is derived from both artifacts).

## Task 5: Verification

Run, in the same order as project CI:

```text
pnpm lint
pnpm typecheck
pnpm build
pnpm test:coverage
```

Also inspect built asset sizes, boot the built app with the existing safe local
configuration if available, and request the JS/CSS routes with gzip accepted to
confirm status, MIME type, content encoding, and immutable cache headers. A live
consumer-app timing comparison is a follow-up if the two external consumer apps
are not available in this standalone repository; do not fabricate that result.

Finally capture `git diff --check`, `git status --short`, and
`git log --oneline -3`. Do not commit.
