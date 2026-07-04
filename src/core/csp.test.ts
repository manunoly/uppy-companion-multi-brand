import { describe, it, expect } from 'vitest';
import { buildConnectSrc, buildFrameAncestors, buildFrameSrc, buildImgSrc, buildScriptSrc } from './csp.js';
import { makeBrand } from '../test-utils/fixtures.js';

// Security review MEDIO-3: helmet's un-derived defaults (connect-src/
// frame-ancestors/frame-src fall back to default-src 'self'; img-src is
// 'self' data:) would block the direct-to-S3 upload, the designer <iframe>
// embed, and the Google Picker. These builders derive the real per-brand CSP.

describe('buildConnectSrc', () => {
    it("is just 'self' when no brand is resolved (global routes)", () => {
        expect(buildConnectSrc(undefined)).toBe("'self'");
    });

    it('includes the brand S3 bucket virtual-hosted-style origin', () => {
        const brand = makeBrand({ s3: { bucket: 'entourage-uploads', region: 'us-east-1' } });
        const connectSrc = buildConnectSrc(brand);
        expect(connectSrc).toContain("'self'");
        expect(connectSrc).toContain('https://entourage-uploads.s3.us-east-1.amazonaws.com');
    });

    it('includes the whoami origin', () => {
        const brand = makeBrand({ auth: { whoamiUrl: 'https://api.test.example.com/auth/me' } });
        expect(buildConnectSrc(brand)).toContain('https://api.test.example.com');
    });

    it('omits the whoami origin when whoamiUrl is malformed/empty, instead of injecting garbage', () => {
        const brand = makeBrand({ auth: { whoamiUrl: '' }, s3: { bucket: '', region: '' } });
        expect(() => buildConnectSrc(brand)).not.toThrow();
        expect(buildConnectSrc(brand)).toBe("'self'");
    });

    it('adds Google API origins only when a Google picker plugin is enabled', () => {
        const withoutPicker = makeBrand({ upload: { plugins: ['Url'], system: 's', systemDetails: 'd' } });
        const withPicker = makeBrand({ upload: { plugins: ['GoogleDrivePicker'], system: 's', systemDetails: 'd' } });
        expect(buildConnectSrc(withoutPicker)).not.toContain('googleapis.com');
        expect(buildConnectSrc(withPicker)).toContain('https://www.googleapis.com');
    });
});

describe('buildFrameAncestors', () => {
    it("is just 'self' when no brand is resolved", () => {
        expect(buildFrameAncestors(undefined)).toBe("'self'");
    });

    it("includes every one of the brand's designer domains, so the designer can embed /uppy", () => {
        const brand = makeBrand({ domains: ['linkdesigner.entourageyearbooks.com', 'designer2.example.com'] });
        const frameAncestors = buildFrameAncestors(brand);
        expect(frameAncestors).toContain("'self'");
        expect(frameAncestors).toContain('https://linkdesigner.entourageyearbooks.com');
        expect(frameAncestors).toContain('https://designer2.example.com');
    });

    it('does not include unrelated hosts', () => {
        const brand = makeBrand({ domains: ['designer.test.example.com'] });
        expect(buildFrameAncestors(brand)).not.toContain('evil.example.com');
    });
});

describe('buildFrameSrc', () => {
    it("is just 'self' when no brand is resolved", () => {
        expect(buildFrameSrc(undefined)).toBe("'self'");
    });

    it("is just 'self' when the picker is not enabled", () => {
        const brand = makeBrand({ upload: { plugins: ['Url'], system: 's', systemDetails: 'd' } });
        expect(buildFrameSrc(brand)).toBe("'self'");
    });

    it('adds Google origins when GooglePhotosPicker is enabled', () => {
        const brand = makeBrand({ upload: { plugins: ['GooglePhotosPicker'], system: 's', systemDetails: 'd' } });
        expect(buildFrameSrc(brand)).toContain('https://docs.google.com');
    });
});

describe('buildImgSrc', () => {
    it("always includes 'self', data:, and blob: (thumbnail previews)", () => {
        expect(buildImgSrc(undefined)).toBe("'self' data: blob:");
    });

    it('adds Google thumbnail origins when the picker is enabled', () => {
        const brand = makeBrand({ upload: { plugins: ['GoogleDrivePicker'], system: 's', systemDetails: 'd' } });
        expect(buildImgSrc(brand)).toContain('https://lh3.googleusercontent.com');
    });
});

describe('buildScriptSrc', () => {
    it("incluye 'self', el nonce por-request y los CDNs base, sin Google por defecto", () => {
        const brand = makeBrand({ upload: { plugins: ['Url'], system: 's', systemDetails: 'd' } });
        const src = buildScriptSrc(brand, 'abc123');
        expect(src).toContain("'self'");
        expect(src).toContain("'nonce-abc123'");
        expect(src).toContain('https://releases.transloadit.com');
        expect(src).toContain('https://cdnjs.cloudflare.com');
        expect(src).not.toContain('apis.google.com');
    });

    it('añade https://apis.google.com solo cuando el picker de Google está habilitado', () => {
        const withPicker = makeBrand({ upload: { plugins: ['GoogleDrivePicker'], system: 's', systemDetails: 'd' } });
        expect(buildScriptSrc(withPicker, 'n')).toContain('https://apis.google.com');
    });

    it("usa la base segura sin Google cuando no hay marca resuelta (rutas globales)", () => {
        const src = buildScriptSrc(undefined, 'n');
        expect(src).toContain("'self'");
        expect(src).not.toContain('apis.google.com');
    });
});
