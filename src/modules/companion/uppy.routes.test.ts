import { describe, it, expect } from 'vitest';
import { toJsStringLiteral, safeJsonForHtmlScript, safePath } from './uppy.routes.js';

describe('toJsStringLiteral', () => {
    it('wraps plain text in single quotes', () => {
        expect(toJsStringLiteral('hello')).toBe("'hello'");
    });

    it('returns "" for null/undefined', () => {
        expect(toJsStringLiteral(null)).toBe("''");
        expect(toJsStringLiteral(undefined)).toBe("''");
    });

    it('escapes backslash before quote (order matters)', () => {
        expect(toJsStringLiteral('a\\b')).toBe("'a\\\\b'");
    });

    it('escapes single quote', () => {
        expect(toJsStringLiteral("a'b")).toBe("'a\\'b'");
    });

    it('escapes newline and carriage return', () => {
        expect(toJsStringLiteral('a\nb\rc')).toBe("'a\\nb\\rc'");
    });

    it('escapes < as \\u003C and > as \\u003E', () => {
        expect(toJsStringLiteral('<x>')).toBe("'\\u003Cx\\u003E'");
    });

    it('escapes U+2028 and U+2029', () => {
        const ls = String.fromCharCode(0x2028);
        const ps = String.fromCharCode(0x2029);
        expect(toJsStringLiteral(`a${ls}b${ps}c`)).toBe("'a\\u2028b\\u2029c'");
    });

    it('blocks </script> closure inside a string literal', () => {
        const out = toJsStringLiteral('</script><script>alert(1)</script>');
        expect(out.includes('</script>')).toBe(false);
        expect(out.includes('\\u003C/script\\u003E')).toBe(true);
    });
});

describe('safeJsonForHtmlScript', () => {
    it('produces JSON-valid output that round-trips via JSON.parse', () => {
        const input = { a: 'hello', b: 42, c: ['x', 'y'] };
        const out = safeJsonForHtmlScript(input);
        expect(JSON.parse(out)).toEqual(input);
    });

    it('escapes < and > so </script> cannot escape the script block', () => {
        const out = safeJsonForHtmlScript({ x: '</script><script>alert(1)</script>' });
        expect(out.includes('</script>')).toBe(false);
        expect(out.includes('\\u003C/script\\u003E')).toBe(true);
    });

    it('output remains valid JSON after escaping', () => {
        const out = safeJsonForHtmlScript({ x: '<!--' });
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it('escapes U+2028 and U+2029 (JS line terminators)', () => {
        const ls = String.fromCharCode(0x2028);
        const out = safeJsonForHtmlScript({ x: ls });
        expect(out).toContain('\\u2028');
    });

    it('handles arrays', () => {
        expect(safeJsonForHtmlScript([1, 2, 3])).toBe('[1,2,3]');
    });

    it('handles empty object', () => {
        expect(safeJsonForHtmlScript({})).toBe('{}');
    });
});

describe('safePath', () => {
    it('returns the path unchanged when it starts with a single slash', () => {
        expect(safePath('/foo/bar')).toBe('/foo/bar');
    });

    it('preserves query string', () => {
        expect(safePath('/foo?a=1')).toBe('/foo?a=1');
    });

    it('falls back to "/" for protocol-relative URLs', () => {
        expect(safePath('//evil.com/path')).toBe('/');
    });

    it('falls back to "/" for absolute http URL', () => {
        expect(safePath('http://evil.com/x')).toBe('/');
    });

    it('falls back to "/" for absolute https URL', () => {
        expect(safePath('https://evil.com/x')).toBe('/');
    });

    it('falls back to "/" for javascript: scheme', () => {
        expect(safePath('javascript:alert(1)')).toBe('/');
    });

    it('falls back to "/" for empty string', () => {
        expect(safePath('')).toBe('/');
    });

    it('falls back to "/" for path that does not start with /', () => {
        expect(safePath('foo')).toBe('/');
    });
});
