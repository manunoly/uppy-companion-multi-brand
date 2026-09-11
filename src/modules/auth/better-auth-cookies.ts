import { buildCookieHeader } from '../brand/identity.js';
import type { BetterAuthCookieNames } from './abe-cookie-names.js';

export function parseCookieEntries(cookieHeader: string): [string, string][] {
    const entries: [string, string][] = [];
    for (const part of cookieHeader.split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) continue;
        const name = part.slice(0, separator).trim();
        if (!name) continue;
        const rawValue = part.slice(separator + 1).trim();
        let value = rawValue;
        try {
            value = decodeURIComponent(rawValue);
        } catch {
            // keep the raw value
        }
        entries.push([name, value]);
    }
    return entries;
}

export function buildBetterAuthPair(
    entries: readonly [string, string][],
    names: BetterAuthCookieNames,
): string | null {
    const token = entries.find(([name]) => name === names.sessionToken)?.[1];
    if (token === undefined) return null;

    const credential = buildCookieHeader(names.sessionToken, token);
    if (credential === null) return null;

    const cache = buildSessionDataPairs(entries, names);
    return cache === null ? credential : [credential, ...cache].join('; ');
}

// Best-effort by contract: session_data's absence is a cache miss, never an authentication
// failure, so an unusable cache cookie must not suppress the credential alongside it.
function buildSessionDataPairs(
    entries: readonly [string, string][],
    names: BetterAuthCookieNames,
): string[] | null {
    // An empty plain value is Better Auth's deletion marker, issued in the same response as
    // fresh chunks — reading it as the value would mask them.
    const plain = entries.find(([name]) => name === names.sessionData)?.[1];
    if (plain) {
        const pair = buildCookieHeader(names.sessionData, plain);
        return pair === null ? null : [pair];
    }

    const prefix = `${names.sessionData}.`;
    const chunks = entries
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, value]) => ({ name, value, index: Number.parseInt(name.slice(prefix.length), 10) }))
        .filter((chunk) => !Number.isNaN(chunk.index))
        .sort((a, b) => a.index - b.index);

    const pairs: string[] = [];
    for (const chunk of chunks) {
        const pair = buildCookieHeader(chunk.name, chunk.value);
        // One bad chunk makes the reassembly garbage upstream — drop the whole cache cookie.
        if (pair === null) return null;
        pairs.push(pair);
    }
    return pairs.length === 0 ? null : pairs;
}

// Forwarded instead of the pair on credential-mismatch: capsule never checks the pair, so
// sending session_data would let it re-authenticate the very JWT we just rejected.
export function buildCredentialOnly(
    entries: readonly [string, string][],
    names: BetterAuthCookieNames,
): string | null {
    const token = entries.find(([name]) => name === names.sessionToken)?.[1];
    if (token === undefined) return null;
    return buildCookieHeader(names.sessionToken, token);
}
