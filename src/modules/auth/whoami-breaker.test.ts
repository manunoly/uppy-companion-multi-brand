import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { makeValidEnv } from '../../test-utils/env-fixtures.js';

// Redis-backed breaker — swap `ioredis` for `ioredis-mock` so tests never touch
// the network, same pattern as `src/lib/redis.test.ts`. `ioredis-mock` shares
// one in-memory store across every `new Redis(...)` instance by default
// (it simulates connecting to a single shared server, which is actually the
// right model for "N replicas talking to one Redis") — so isolation between
// tests comes from `flushall()` in `beforeEach`, not from re-importing modules.
vi.mock('ioredis', async () => {
    const { default: RedisMock } = await import('ioredis-mock');
    return { default: RedisMock, Redis: RedisMock };
});
vi.mock('../../config/index.js', () => ({
    env: makeValidEnv({ redisUrl: 'redis://localhost:6379' }),
}));

const { getRedis, closeRedis } = await import('../../lib/redis.js');
const { isOpen, recordFailure, recordSuccess, tryHalfOpen } = await import('./whoami-breaker.js');

describe('whoami-breaker (src/modules/auth/whoami-breaker.ts)', () => {
    beforeEach(async () => {
        await getRedis().flushall();
        // Only fake `Date` — the breaker's own half-open cooldown math is
        // `Date.now()`-based (see whoami-breaker.ts), while ioredis-mock's
        // EX/TTL bookkeeping uses real `setTimeout`s internally; faking those
        // too would make key expiry unpredictable without actually waiting.
        vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    afterAll(async () => {
        await closeRedis();
    });

    it('is closed by default (isOpen === false) for a brand nobody has recorded anything for', async () => {
        await expect(isOpen('edo')).resolves.toBe(false);
    });

    it('3 consecutive recordFailure calls open the circuit', async () => {
        await recordFailure('edo');
        await expect(isOpen('edo')).resolves.toBe(false);
        await recordFailure('edo');
        await expect(isOpen('edo')).resolves.toBe(false);
        await recordFailure('edo');
        await expect(isOpen('edo')).resolves.toBe(true);
    });

    it('recordSuccess closes the circuit and clears the failure counter', async () => {
        await recordFailure('edo');
        await recordFailure('edo');
        await recordFailure('edo');
        await expect(isOpen('edo')).resolves.toBe(true);

        await recordSuccess('edo');
        await expect(isOpen('edo')).resolves.toBe(false);

        // Counter was cleared, not just the open flag — two more failures should
        // NOT re-open the circuit (threshold is 3, starting fresh from 0).
        await recordFailure('edo');
        await recordFailure('edo');
        await expect(isOpen('edo')).resolves.toBe(false);
    });

    it('circuit breakers are independent per brand slug', async () => {
        await recordFailure('edo');
        await recordFailure('edo');
        await recordFailure('edo');
        await expect(isOpen('edo')).resolves.toBe(true);
        await expect(isOpen('abe')).resolves.toBe(false);
    });

    it('after the open cooldown elapses, isOpen grants exactly one half-open probe (tryHalfOpen)', async () => {
        await recordFailure('edo');
        await recordFailure('edo');
        await recordFailure('edo');
        await expect(isOpen('edo')).resolves.toBe(true);

        // Advance past the 30s cooldown.
        vi.setSystemTime(Date.now() + 30_001);

        // The FIRST caller to check isOpen() after cooldown wins the probe slot
        // (isOpen() returns false so it can proceed with a real whoami call);
        // it must also have consumed the underlying half-open lock, so a
        // subsequent tryHalfOpen() call finds it already taken.
        await expect(isOpen('edo')).resolves.toBe(false);
        await expect(tryHalfOpen('edo')).resolves.toBe(false);
    });

    it('tryHalfOpen: only one of two concurrent callers wins the probe slot', async () => {
        const [a, b] = await Promise.all([tryHalfOpen('edo'), tryHalfOpen('edo')]);
        // Exactly one of the two concurrent calls should win.
        expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it('while still within the open cooldown, isOpen stays true and does not grant a probe', async () => {
        await recordFailure('edo');
        await recordFailure('edo');
        await recordFailure('edo');

        vi.setSystemTime(Date.now() + 5_000); // well within the 30s cooldown
        await expect(isOpen('edo')).resolves.toBe(true);
        // No probe should have been granted — the slot is still free for later.
        await expect(tryHalfOpen('edo')).resolves.toBe(true);
    });

    it('a failed half-open probe (recordFailure again) keeps the circuit open', async () => {
        await recordFailure('edo');
        await recordFailure('edo');
        await recordFailure('edo');
        vi.setSystemTime(Date.now() + 30_001);
        await expect(isOpen('edo')).resolves.toBe(false); // won the probe

        await recordFailure('edo'); // the probe's own whoami call failed
        await expect(isOpen('edo')).resolves.toBe(true);
    });
});
