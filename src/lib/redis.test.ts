import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeValidEnv } from '../test-utils/env-fixtures.js';

// Swap the real `ioredis` client for `ioredis-mock` so tests never touch the
// network. `ioredis-mock`'s default export is API-compatible with `ioredis`'s
// `Redis` class; `src/lib/redis.ts` imports it as the named `Redis` export.
vi.mock('ioredis', async () => {
    const { default: RedisMock } = await import('ioredis-mock');
    return { default: RedisMock, Redis: RedisMock };
});

describe('redis client (src/lib/redis.ts)', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../config/index.js', () => ({
            env: makeValidEnv({ redisUrl: 'redis://localhost:6379' }),
        }));
    });

    afterEach(() => {
        vi.doUnmock('../config/index.js');
    });

    it('getRedis() returns the same instance on repeated calls (singleton)', async () => {
        const { getRedis, closeRedis } = await import('./redis.js');
        const a = getRedis();
        const b = getRedis();
        expect(a).toBe(b);
        await closeRedis();
    });

    it('set/get round-trips through the (mocked) client', async () => {
        const { getRedis, closeRedis } = await import('./redis.js');
        const client = getRedis();
        await client.set('foo', 'bar');
        await expect(client.get('foo')).resolves.toBe('bar');
        await closeRedis();
    });

    it('closeRedis() tears the singleton down so the next getRedis() builds a fresh client', async () => {
        const { getRedis, closeRedis } = await import('./redis.js');
        const a = getRedis();
        await closeRedis();
        const b = getRedis();
        expect(a).not.toBe(b);
        await closeRedis();
    });

    it('closeRedis() is a no-op when no client was ever created', async () => {
        const { closeRedis } = await import('./redis.js');
        await expect(closeRedis()).resolves.toBeUndefined();
    });
});
