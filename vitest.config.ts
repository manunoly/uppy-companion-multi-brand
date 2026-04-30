import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        include: ['src/**/*.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/index.ts',
                'src/index.ts',
                'src/config/env.ts',
                'src/modules/companion/uppyModal.ts',
                '**/*.types.ts',
                '**/*.test.ts',
                'src/test-utils/**',
                'dist/**',
                'node_modules/**',
                'scripts/**',
            ],
            thresholds: {
                lines: 70,
                branches: 60,
                functions: 70,
                statements: 70,
            },
        },
    },
});
