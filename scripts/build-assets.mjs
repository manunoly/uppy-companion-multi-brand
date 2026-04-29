import { transform } from 'esbuild';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src/modules/companion');
const DIST = path.join(ROOT, 'dist/modules/companion');

await mkdir(DIST, { recursive: true });

const ts = await readFile(path.join(SRC, 'uppyModal.ts'), 'utf8');
const result = await transform(ts, {
    loader: 'ts',
    target: 'es2020',
    format: 'esm',
    // No sourcemap in the production artifact — inline maps embed the full TS
    // source into the shipped file, exposing it to any client (OWASP A05).
    // Dev mode uses the runtime esbuild fallback in uppy.routes.ts.
});
await writeFile(path.join(DIST, 'uppyModal.js'), result.code);

await copyFile(path.join(SRC, 'uppy.html'), path.join(DIST, 'uppy.html'));

console.log('[build-assets] dist/modules/companion/{uppyModal.js,uppy.html}');
