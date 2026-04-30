import { S3Client } from '@aws-sdk/client-s3';
import type { Brand, BrandRegistry } from '../modules/brand/brand.types.js';
import type { AppRequest } from '../core/types/express.js';
import type { AuthUser } from '../modules/auth/auth.types.js';

export const makeBrand = (overrides: Partial<Brand> = {}): Brand => {
    // Derive id-dependent fields BEFORE the spread so that callers who only
    // override `id` still get a coherent Brand (companionUrl + server.path
    // matching the new id). Direct overrides for those fields still win via
    // the trailing `...overrides`.
    const id = overrides.id ?? 'test';
    return {
        id,
        displayName: 'Test',
        rootDomain: 'test.example.com',
        companionUrl: `http://localhost:3020/${id}`,
        auth: {
            url: 'https://api.test.example.com/auth/me',
            cookieName: 'session',
        },
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
        corsOrigins: [],
        uploadUrls: ['*'],
        secret: 'test-secret-value-1234567890',
        public: {
            backendUrl: 'https://app.test.example.com',
            uploadUrl: 'https://app.test.example.com/api/upload',
            foldersUrl: 'https://app.test.example.com/api/folders',
            loginUrl: 'https://app.test.example.com/login',
        },
        server: {
            host: 'localhost:3020',
            protocol: 'http',
            path: `/${id}`,
        },
        filePath: '/tmp/',
        enabledPlugins: [],
        ...overrides,
    };
};

export const makeBrandWithoutAuth = (overrides: Partial<Brand> = {}): Brand =>
    makeBrand({
        rootDomain: null,
        auth: { url: null, cookieName: 'session' },
        public: {
            backendUrl: 'https://app.test.example.com',
            uploadUrl: 'https://app.test.example.com/api/upload',
            foldersUrl: undefined,
            loginUrl: undefined,
        },
        ...overrides,
    });

export const makeBrandRegistry = (brands?: Brand[]): BrandRegistry => {
    const list = brands && brands.length > 0 ? brands : [makeBrand()];
    const map = new Map(list.map(b => [b.id, b]));
    return {
        brands: map,
        defaultBrand: list[0] ?? null,
    };
};

export const makeUser = (overrides: Partial<AuthUser> = {}): AuthUser => ({
    id: 'u123',
    email: 'test@example.com',
    name: 'Test User',
    roles: [],
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
