import { S3Client } from '@aws-sdk/client-s3';
import type { Brand, BrandAuthConfig, BrandUser } from '../modules/brand/brand.types.js';
import type { ResolvedBrandRegistry } from '../modules/brand/brand.service.js';
import type { AppRequest } from '../core/types/express.js';

// `auth` and `s3` are deep-merged over the defaults below (not replaced
// wholesale) so callers can override a single nested field — e.g.
// `makeBrand({ auth: { whoamiAllowedHosts: [] } })` — without having to
// restate the rest of a `BrandAuthConfig` union member.
type BrandOverrides = Partial<Omit<Brand, 'auth' | 's3'>> & {
    auth?: Partial<BrandAuthConfig>;
    s3?: Partial<Brand['s3']>;
};

const defaultAuth: BrandAuthConfig = {
    kind: 'partner-whoami',
    signInUrl: 'https://app.test.example.com/login',
    signOutUrl: 'https://app.test.example.com/logout',
    whoamiUrl: 'https://api.test.example.com/auth/me',
    whoamiAllowedHosts: ['test.example.com'],
    sessionCookieName: 'session',
    responseMapping: { idField: 'id', emailField: 'email', nameField: 'name', imageField: 'imageUrl' },
};

export const makeBrand = (overrides: BrandOverrides = {}): Brand => {
    const { auth: authOverride, s3: s3Override, ...rest } = overrides;
    const slug = rest.slug ?? 'edo';

    const base: Brand = {
        slug,
        name: 'Test Brand',
        domains: ['designer.test.example.com'],
        companionHosts: ['companion.test.example.com'],
        auth: defaultAuth,
        assets: { s3Prefix: '' },
        upload: { plugins: ['Url'], system: 'TEST', systemDetails: 'TEST' },
        limits: { maxUploadBytes: 50 * 1024 * 1024 },
        public: { foldersUrl: 'https://app.test.example.com/api/folders' },
        companionUrl: 'http://localhost:3020',
        secret: 'test-secret-value-1234567890',
        s3: {
            bucket: 'test-bucket',
            region: 'us-east-1',
            accessKey: 'AKIATESTKEY',
            secretKey: 'testsecretkey',
            useAccelerateEndpoint: false,
            client: new S3Client({
                region: 'us-east-1',
                credentials: { accessKeyId: 'AKIATESTKEY', secretAccessKey: 'testsecretkey' },
            }),
        },
        providers: {},
    };

    return {
        ...base,
        ...rest,
        auth: authOverride ? ({ ...base.auth, ...authOverride } as BrandAuthConfig) : base.auth,
        s3: s3Override ? { ...base.s3, ...s3Override } : base.s3,
    };
};

export const makeBrandRegistry = (brands?: Brand[]): ResolvedBrandRegistry => {
    const list = brands && brands.length > 0 ? brands : [makeBrand()];
    const entries = list.map((brand) => [brand.slug, brand] as const);
    return Object.freeze(Object.fromEntries(entries)) as ResolvedBrandRegistry;
};

export const makeUser = (overrides: Partial<BrandUser> = {}): BrandUser => ({
    id: 'u123',
    email: 'test@example.com',
    displayName: 'Test User',
    imageUrl: null,
    ...overrides,
});

export const makeAppRequest = (overrides: Partial<AppRequest> = {}): AppRequest => {
    const headers: Record<string, string> = {};
    const cookies: Record<string, string> = {};
    const req = {
        headers,
        cookies,
        query: {},
        params: {},
        body: {},
        method: 'GET',
        url: '/',
        originalUrl: '/',
        get(name: string): string | undefined {
            return headers[name.toLowerCase()];
        },
        ...overrides,
    } as unknown as AppRequest;
    return req;
};
