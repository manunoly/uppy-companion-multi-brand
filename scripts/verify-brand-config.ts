
import 'dotenv/config';
import { createBrandRegistry, getAllBrands } from '../src/modules/brand/index.js';
import type { BrandConfigJSON } from '../src/modules/brand/brand.types.js';

console.log('🔍 Verifying Brand Configuration from Environment...');

try {
    // 1. Initialize Registry (this reads process.env.COMPANION_BRANDS)
    const registry = createBrandRegistry({
        corsOrigins: [],
        secret: process.env.COMPANION_SECRET || 'test-secret',
        filePath: process.env.COMPANION_FILE_PATH || '/tmp',
        host: process.env.COMPANION_HOST || 'localhost:3020',
        protocol: (process.env.COMPANION_PROTOCOL as 'http' | 'https') || 'http'
    });

    const brands = getAllBrands(registry);

    if (brands.length === 0) {
        console.warn('⚠️ No brands found. Please check COMPANION_BRANDS in your .env file.');
    } else {
        console.log(`✅ Found ${brands.length} brand(s) configured:\n`);

        for (const brand of brands) {
            console.log(`[Brand: ${brand.id}]`);
            console.log(`  - Name: ${brand.displayName}`);
            console.log(`  - Auth URL: ${brand.authUrl || '(Not configured) ⚠️'}`);
            console.log(`  - Public Backend: ${brand.publicBackendUrl}`);

            // 1. Analyze Active Providers (from Registry)
            const activeProviders: string[] = [];
            for (const [name, config] of Object.entries(brand.providers)) {
                if (config) {
                    activeProviders.push(name);
                }
            }

            if (activeProviders.length > 0) {
                console.log(`  - Active Providers: ${activeProviders.join(', ')}`);
            } else {
                console.log(`  - Active Providers: (None)`);
            }

            console.log(`  - S3 Bucket: ${brand.s3.bucket || '(Global Default/None) ⚠️'}`);

            // 2. Analyze Raw JSON with Type Safety
            const envKey = brand.id.replace(/-/g, '_').toUpperCase();
            const rawJson = process.env[envKey];

            if (rawJson) {
                try {
                    const config = JSON.parse(rawJson) as BrandConfigJSON;

                    // Check Providers in JSON
                    if (config.providers) {
                        const invalidConfigs: string[] = [];

                        // Iterate strictly using the typed object
                        for (const key of Object.keys(config.providers)) {
                            const providerName = key as keyof typeof config.providers;
                            const p = config.providers[providerName];

                            if (p) {
                                const issues: string[] = [];
                                if (!p.key || p.key.trim() === '') issues.push('missing key');
                                if (!p.secret || p.secret.trim() === '') issues.push('missing secret');

                                if (issues.length > 0) {
                                    invalidConfigs.push(`${providerName} (${issues.join(', ')})`);
                                }
                            }
                        }

                        if (invalidConfigs.length > 0) {
                            console.warn(`  ⚠️  Config Issues in JSON: ${invalidConfigs.join('; ')}`);
                        }
                    }

                    // Check S3 in JSON
                    if (config.s3) {
                        const s3Warnings: string[] = [];
                        if (!config.s3.bucket) s3Warnings.push('bucket missing');
                        if (!config.s3.region) s3Warnings.push('region missing');
                        if (s3Warnings.length > 0) {
                            console.warn(`  ⚠️  S3 Config Issues in JSON: ${s3Warnings.join(', ')}`);
                        }
                    }

                } catch (e) {
                    console.warn(`  ⚠️  Invalid JSON in env var ${envKey}`);
                }
            }

            console.log('');
        }
    }

} catch (error) {
    console.error('❌ Configuration Verification Failed:', error);
    process.exit(1);
}
