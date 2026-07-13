import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src/modules/companion');
const DIST = path.join(ROOT, 'dist/modules/companion');
const JS_PATH = path.join(DIST, 'uppyModal.js');
const CSS_PATH = path.join(DIST, 'uppyModal.css');

await mkdir(DIST, { recursive: true });

await build({
    entryPoints: [path.join(SRC, 'uppyModal.ts')],
    outfile: JS_PATH,
    bundle: true,
    minify: true,
    target: 'es2020',
    format: 'esm',
    platform: 'browser',
    // The public production artifact intentionally excludes bundled source.
    sourcemap: false,
});

const [js, css, htmlTemplate] = await Promise.all([
    readFile(JS_PATH),
    readFile(CSS_PATH),
    readFile(path.join(SRC, 'uppy.html'), 'utf8'),
]);
const assetVersion = createHash('sha256').update(js).update(css).digest('hex').slice(0, 16);
const html = htmlTemplate.replaceAll('UPPY_ASSET_VERSION', assetVersion);

await writeFile(path.join(DIST, 'uppy.html'), html);

console.log(`[build-assets] dist/modules/companion/{uppyModal.js,uppyModal.css,uppy.html} v=${assetVersion}`);
