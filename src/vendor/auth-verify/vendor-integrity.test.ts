import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

// Enforces VENDORED.md's "do not edit": a hand edit here changes a hash and fails CI.
describe('vendored auth-verify integrity', () => {
    it('every .ts file matches MANIFEST.sha256', () => {
        const manifest = new Map(
            readFileSync(join(here, 'MANIFEST.sha256'), 'utf8')
                .split('\n')
                .filter((line) => line.trim() !== '')
                .map((line) => {
                    const [hash, name] = line.trim().split(/\s+/);
                    return [name.replace(/^\*/, ''), hash] as const;
                }),
        );

        const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
        expect(sources.sort()).toEqual(['index.ts', 'jwks.ts', 'sessionCookie.ts', 'verify.ts']);

        for (const name of sources) {
            const actual = createHash('sha256').update(readFileSync(join(here, name))).digest('hex');
            expect(actual, `${name} was modified — fix it upstream and re-sync`).toBe(manifest.get(name));
        }
    });
});
