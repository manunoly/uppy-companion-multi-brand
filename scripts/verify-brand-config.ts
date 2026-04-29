
import 'dotenv/config';
import { brandConfigSchema } from '../src/modules/brand/brand.schema.js';
import { normalizeBrandSlug } from '../src/modules/brand/brand.utils.js';
import { createBrandRegistry, getAllBrands } from '../src/modules/brand/index.js';
import type { BrandConfigJSON, BrandProviderInputConfig } from '../src/modules/brand/brand.types.js';

const parseCsv = (value: string | undefined): string[] => {
    if (!value) return [];
    return value.split(',').map(s => s.trim()).filter(Boolean);
};

const parseProtocol = (value: string | undefined): 'http' | 'https' => {
    return value?.toLowerCase() === 'https' ? 'https' : 'http';
};

const toBrandEnvKey = (slug: string): string => {
    return normalizeBrandSlug(slug).replace(/-/g, '_').toUpperCase();
};

const parseBrandConfigsForVerifier = (
    brands: string
): { brandConfigs: Record<string, BrandConfigJSON>; issuesByBrand: Record<string, string[]> } => {
    const slugs = [...new Set(
        brands.split(',').map(normalizeBrandSlug).filter(Boolean)
    )];

    const brandConfigs: Record<string, BrandConfigJSON> = {};
    const issuesByBrand: Record<string, string[]> = {};

    for (const slug of slugs) {
        const envKey = toBrandEnvKey(slug);
        const rawJson = process.env[envKey];

        if (!rawJson) continue;

        let jsonConfig: unknown;
        try {
            jsonConfig = JSON.parse(rawJson);
        } catch (error) {
            issuesByBrand[slug] = [`Invalid JSON in env var ${envKey}`];
            continue;
        }

        const parsed = brandConfigSchema.safeParse(jsonConfig);
        if (!parsed.success) {
            issuesByBrand[slug] = parsed.error.issues.map(issue => issue.message);
            continue;
        }

        brandConfigs[slug] = parsed.data;
    }

    return { brandConfigs, issuesByBrand };
};

console.log('🔍 Verifying Brand Configuration from Environment...');

try {
    const brands = process.env.COMPANION_BRANDS ?? 'default';
    const protocol = parseProtocol(process.env.COMPANION_PROTOCOL);
    const host = process.env.COMPANION_HOST ?? 'localhost:3020';
    const { brandConfigs, issuesByBrand } = parseBrandConfigsForVerifier(brands);

    // 1. Initialize Registry from verifier-local parsing (does not require full env validation)
    const registry = createBrandRegistry({
        corsOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS),
        secret: process.env.COMPANION_SECRET ?? 'verify-script-secret-123456',
        filePath: process.env.COMPANION_FILE_PATH ?? '/tmp/',
        host,
        protocol,
        brands,
        brandConfigs,
        publicDefaults: {
            backendUrl: process.env.PUBLIC_BACKEND_URL,
            uploadUrl: process.env.PUBLIC_UPLOAD_URL,
            foldersUrl: process.env.PUBLIC_FOLDERS_URL,
        },
        s3Defaults: {
            bucket: process.env.AWS_BUCKET_NAME,
            region: process.env.AWS_REGION,
            accessKey: process.env.AWS_ACCESS_KEY_ID,
            secretKey: process.env.AWS_SECRET_ACCESS_KEY,
            useAccelerateEndpoint: process.env.COMPANION_AWS_ACCELERATE_ENDPOINT === 'true',
        },
        providerDefaults: {
            google: {
                clientId: process.env.COMPANION_GOOGLE_CLIENT_ID,
                clientSecret: process.env.COMPANION_GOOGLE_CLIENT_SECRET,
                driveApiKey: process.env.COMPANION_GOOGLE_DRIVE_API_KEY,
                photosApiKey: process.env.COMPANION_GOOGLE_PHOTOS_API_KEY,
                appId: process.env.COMPANION_GOOGLE_APP_ID,
            },
            dropbox: { key: process.env.COMPANION_DROPBOX_KEY, secret: process.env.COMPANION_DROPBOX_SECRET },
            facebook: { key: process.env.COMPANION_FACEBOOK_KEY, secret: process.env.COMPANION_FACEBOOK_SECRET },
            instagram: { key: process.env.COMPANION_INSTAGRAM_KEY, secret: process.env.COMPANION_INSTAGRAM_SECRET },
            onedrive: { key: process.env.COMPANION_ONEDRIVE_KEY, secret: process.env.COMPANION_ONEDRIVE_SECRET },
            box: { key: process.env.COMPANION_BOX_KEY, secret: process.env.COMPANION_BOX_SECRET },
            unsplash: { key: process.env.COMPANION_UNSPLASH_KEY, secret: process.env.COMPANION_UNSPLASH_SECRET },
            zoom: { key: process.env.COMPANION_ZOOM_KEY, secret: process.env.COMPANION_ZOOM_SECRET },
        },
    });

    const allBrands = getAllBrands(registry);

    if (allBrands.length === 0) {
        console.warn('⚠️ No brands found. Please check COMPANION_BRANDS in your .env file.');
    } else {
        console.log(`✅ Found ${allBrands.length} brand(s) configured:\n`);

        for (const brand of allBrands) {
            console.log(`[Brand: ${brand.id}]`);
            console.log(`  - Name: ${brand.displayName}`);
            console.log(`  - Auth URL: ${brand.auth.url || '(Not configured) ⚠️'}`);
            console.log(`  - Public Backend: ${brand.public.backendUrl}`);
            console.log(`  - Root domain: ${brand.rootDomain ?? '(not set)'}`);
            console.log(`  - Login URL: ${brand.public.loginUrl ?? '(not set)'}`);

            // rootDomain is only required when auth.url is set. Mirror the
            // brandConfigSchema superRefine invariant so deploy fails early.
            if (brand.auth.url && !brand.rootDomain) {
                console.error(`  ❌ Brand "${brand.id}" has auth.url but no rootDomain — uploads will be rejected at startup.`);
                process.exitCode = 1;
            }

            // loginUrl is optional but strongly recommended; without it,
            // unauthenticated /uppy hits get a static error page rather than
            // a redirect to the dashboard.
            if (brand.auth.url && !brand.public.loginUrl) {
                console.warn(`  ⚠️  Brand "${brand.id}" has no public.loginUrl — unauthenticated /uppy will show a static 401 page instead of redirecting to login.`);
            }

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

            const schemaIssues = issuesByBrand[brand.id];
            if (schemaIssues?.length) {
                console.warn(`  ⚠️  Invalid config schema: ${schemaIssues.join('; ')}`);
            }

            const config = brandConfigs[brand.id];
            if (config?.providers) {
                const providerIssues: string[] = [];

                for (const [providerName, provider] of Object.entries(config.providers)) {
                    if (!provider) continue;

                    if (providerName === 'google') {
                        if (!provider.clientId || provider.clientId.trim() === '') {
                            providerIssues.push('google (missing clientId)');
                        }
                        continue;
                    }

                    const oauthProvider = provider as BrandProviderInputConfig;
                    const issues: string[] = [];
                    if (!oauthProvider.key || oauthProvider.key.trim() === '') issues.push('missing key');
                    if (!oauthProvider.secret || oauthProvider.secret.trim() === '') issues.push('missing secret');

                    if (issues.length > 0) {
                        providerIssues.push(`${providerName} (${issues.join(', ')})`);
                    }
                }

                if (providerIssues.length > 0) {
                    console.warn(`  ⚠️  Config Issues in JSON: ${providerIssues.join('; ')}`);
                }
            }

            if (config?.s3) {
                const s3Warnings: string[] = [];
                if (!config.s3.bucket) s3Warnings.push('bucket missing');
                if (!config.s3.region) s3Warnings.push('region missing');
                if (s3Warnings.length > 0) {
                    console.warn(`  ⚠️  S3 Config Issues in JSON: ${s3Warnings.join(', ')}`);
                }
            }

            console.log('');
        }
    }

} catch (error) {
    console.error('❌ Configuration Verification Failed:', error);
    process.exit(1);
}
