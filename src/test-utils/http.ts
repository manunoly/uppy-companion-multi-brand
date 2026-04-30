import { vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { Brand, BrandRegistry } from '../modules/brand/brand.types.js';
import type { CompanionInstance } from '../modules/companion/companion.factory.js';
import type { EnvConfig } from '../config/env.schema.js';
import { makeBrand, makeBrandRegistry } from './fixtures.js';
import { makeValidEnv } from './env-fixtures.js';

export interface CreateTestAppOptions {
    brands?: Brand[];
    env?: EnvConfig;
}

/**
 * Builds an Express app for integration tests.
 *
 * Mocks `@uppy/companion` so creating instances doesn't reach the network or
 * spin up real OAuth handlers. AWS SDK is NOT mocked here — tests that exercise
 * `/api/uppy/*` should set up `aws-sdk-client-mock` themselves via `mockClient(S3Client)`.
 */
export const createTestApp = async (
    opts: CreateTestAppOptions = {},
): Promise<{ app: Express; brandRegistry: BrandRegistry }> => {
    const brands = opts.brands ?? [makeBrand()];
    const env = opts.env ?? makeValidEnv();
    const brandRegistry = makeBrandRegistry(brands);

    // Mock companion before importing assembleApp.
    vi.doMock('@uppy/companion', () => ({
        default: {
            app: vi.fn(() => ({ app: express.Router() })),
            socket: vi.fn(),
        },
        app: vi.fn(() => ({ app: express.Router() })),
        socket: vi.fn(),
    }));

    // Mock the config module so server.ts doesn't call deriveEnv() at import time
    // (which would fail in tests without real env vars like COMPANION_SECRET).
    vi.doMock('../config/index.js', () => ({
        env,
    }));

    // Silence console.log during assembleApp to suppress mount messages.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
        // Build companion instances with the mocked module.
        const { createCompanionForBrand } = await import('../modules/companion/companion.factory.js');
        const companionInstances: CompanionInstance[] = brands.map(brand => createCompanionForBrand(brand));

        const { assembleApp } = await import('../server.js');
        const app = assembleApp({ env, brandRegistry, companionInstances });

        return { app, brandRegistry };
    } finally {
        logSpy.mockRestore();
    }
};
