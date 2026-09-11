import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBrand } from '../../test-utils/fixtures.js';

const verifySessionCookie = vi.fn();
vi.mock('../../vendor/auth-verify/index.js', () => ({
    createJwksCache: vi.fn(() => ({ get: vi.fn(), refresh: vi.fn() })),
    verifySessionCookie: (...args: unknown[]) => verifySessionCookie(...args),
}));

const { createAbeSessionVerifier, getAbeSessionVerifier } = await import('./abe-session-verifier.js');

const abe = makeBrand({
    slug: 'abe',
    auth: {
        kind: 'capsule',
        authIssuer: 'https://auth.example.test',
        authAllowedHosts: ['example.test'],
    },
});

describe('createAbeSessionVerifier', () => {
    beforeEach(() => {
        verifySessionCookie.mockReset();
    });

    it('returns null for a brand with no valid auth origin', () => {
        expect(createAbeSessionVerifier(makeBrand({ slug: 'edo' }))).toBeNull();
    });

    it('getAbeSessionVerifier returns the SAME instance across calls (the JWKS cache must outlive the request)', () => {
        const first = getAbeSessionVerifier(abe);
        const second = getAbeSessionVerifier(abe);

        expect(first).not.toBeNull();
        expect(second).toBe(first);
    });

    it('getAbeSessionVerifier returns a NEW instance when the issuer changes', () => {
        const first = getAbeSessionVerifier(abe);
        const moved = makeBrand({
            slug: 'abe',
            auth: {
                kind: 'capsule',
                authIssuer: 'https://auth2.example.test',
                authAllowedHosts: ['example.test'],
            },
        });

        expect(getAbeSessionVerifier(moved)).not.toBe(first);
    });

    it('maps a valid result to a complete BrandUser plus the verified-email claim', async () => {
        verifySessionCookie.mockResolvedValue({
            status: 'valid',
            user: { id: 'u1', email: 'a@b.test', emailVerified: true, name: 'Ada', image: 'https://img.test/a.png' },
            session: {},
        });

        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier?.verify('better-auth.session_token=t');

        expect(result).toEqual({
            status: 'valid',
            user: { id: 'u1', email: 'a@b.test', displayName: 'Ada', imageUrl: 'https://img.test/a.png' },
            emailVerified: true,
        });
    });

    it('a null name and image become null, not the string "null"', async () => {
        verifySessionCookie.mockResolvedValue({
            status: 'valid',
            user: { id: 'u1', email: 'a@b.test', emailVerified: false, name: null, image: null },
            session: {},
        });

        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier?.verify('better-auth.session_token=t');

        expect(result).toEqual({
            status: 'valid',
            user: { id: 'u1', email: 'a@b.test', displayName: null, imageUrl: null },
            emailVerified: false,
        });
    });

    it('an id that fails PARTNER_ID_PATTERN is poisoned, not valid', async () => {
        verifySessionCookie.mockResolvedValue({
            status: 'valid',
            user: { id: 'has spaces and/slashes', email: 'a@b.test', emailVerified: true },
            session: {},
        });

        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier?.verify('better-auth.session_token=t');

        expect(result).toEqual({ status: 'miss', cause: 'poisoned' });
    });

    it('an email with no @ is poisoned, not valid', async () => {
        verifySessionCookie.mockResolvedValue({
            status: 'valid',
            user: { id: 'u1', email: 'not-an-email', emailVerified: true },
            session: {},
        });

        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier?.verify('better-auth.session_token=t');

        expect(result).toEqual({ status: 'miss', cause: 'poisoned' });
    });

    it.each(['absent', 'expired', 'poisoned', 'credential-mismatch', 'unavailable'] as const)(
        'passes %s through as a miss cause',
        async (status) => {
            verifySessionCookie.mockResolvedValue({ status });

            const verifier = createAbeSessionVerifier(abe);
            const result = await verifier?.verify('better-auth.session_token=t');

            expect(result).toEqual({ status: 'miss', cause: status });
        },
    );

    it('an absent cookie header is a miss without calling the verifier', async () => {
        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier?.verify(undefined);

        expect(result).toEqual({ status: 'miss', cause: 'absent' });
        expect(verifySessionCookie).not.toHaveBeenCalled();
    });

    it('a header Headers() rejects is poisoned, not unavailable', async () => {
        const verifier = createAbeSessionVerifier(abe);
        const result = await verifier?.verify('bad\nheader=1');

        expect(result).toEqual({ status: 'miss', cause: 'poisoned' });
        expect(verifySessionCookie).not.toHaveBeenCalled();
    });
});

describe('vendored verifier, unmocked', () => {
    const issuer = 'https://auth.example.test';

    const mint = async () => {
        const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
        const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
        const jwk = { ...(await exportJWK(publicKey)), alg: 'EdDSA', kid: 'k1' };
        const token = 'tok';

        const jwt = await new SignJWT({
            user: { id: 'u1', email: 'a@b.test', emailVerified: true },
            session: { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
            // parseSessionPayload requires sid === session.token; without it every mint is poisoned.
            sid: token,
        })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'k1', typ: 'better-auth.session-cache+jwt' })
            .setIssuer(issuer)
            .setAudience('better-auth:session-cache')
            .setSubject('u1')
            .setExpirationTime('5m')
            .sign(privateKey);

        return { jwt, jwk, token };
    };

    const verifyWith = async (cookie: string, jwk: Record<string, unknown>) => {
        const { verifySessionCookie: real } = await vi.importActual<
            typeof import('../../vendor/auth-verify/index.js')
        >('../../vendor/auth-verify/index.js');
        return real(new Headers({ cookie }), {
            jwks: { get: async () => ({ keys: [jwk] }), refresh: async () => ({ keys: [jwk] }) },
            issuer,
            sessionDataName: 'better-auth.session_data',
            sessionTokenName: 'better-auth.session_token',
        });
    };

    it('verifies a real EdDSA session_data bound to its credential', async () => {
        const { jwt, jwk, token } = await mint();

        const result = await verifyWith(
            `better-auth.session_token=${token}.sig; better-auth.session_data=${jwt}`,
            jwk,
        );

        expect(result.status).toBe('valid');
    });

    it('rejects the same JWT presented with a foreign credential', async () => {
        const { jwt, jwk } = await mint();

        const result = await verifyWith(
            `better-auth.session_token=someone-elses.sig; better-auth.session_data=${jwt}`,
            jwk,
        );

        expect(result.status).toBe('credential-mismatch');
    });
});
