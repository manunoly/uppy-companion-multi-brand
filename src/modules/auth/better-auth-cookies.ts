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

    const pairs: string[] = [];
    const push = (name: string, value: string): boolean => {
        const pair = buildCookieHeader(name, value);
        if (pair === null) return false;
        pairs.push(pair);
        return true;
    };
    if (!push(names.sessionToken, token)) return null;

    const plain = entries.find(([name]) => name === names.sessionData)?.[1];
    if (plain !== undefined) {
        if (!push(names.sessionData, plain)) return null;
    } else {
        const prefix = `${names.sessionData}.`;
        const chunks = entries
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, value]) => ({ name, value, index: Number.parseInt(name.slice(prefix.length), 10) }))
            .filter((chunk) => !Number.isNaN(chunk.index));
        for (const chunk of [...chunks].sort((a, b) => a.index - b.index)) {
            if (!push(chunk.name, chunk.value)) return null;
        }
    }
    return pairs.join('; ');
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
