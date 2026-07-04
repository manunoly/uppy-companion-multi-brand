import type { Redis } from 'ioredis';
import { getRedis } from '../../lib/redis.js';
import type { BrandSlug } from '../brand/slugs.js';

/**
 * Redis-backed circuit breaker for the per-brand whoami fetch (session-resolver.ts).
 *
 * NEW DESIGN — not a port. abeduls3's equivalents are both in-memory (per-process,
 * single Next.js/Node server), which is fine there but wrong here: the Companion
 * runs >=2 replicas behind Railway with no sticky sessions (spec D7), so breaker
 * state MUST be shared or each replica would trip/half-open independently,
 * defeating the point of "stop hammering a failing partner".
 *   - `apps/designer/lib/auth/whoamiBreaker.ts` — in-memory `Map<BrandSlug, ...>`.
 *   - `apps/node-socket/src/persistence/circuit-breaker.ts` — also in-memory,
 *     and actually a different subsystem entirely (generic retry/backoff for
 *     persistence writes, not auth).
 *
 * State model (per brand slug), three Redis keys:
 *  - `whoami:breaker:{slug}:failures` — INCR'd atomically on every failure, with
 *    a sliding-window TTL so stray old failures eventually age out even without
 *    an intervening success.
 *  - `whoami:breaker:{slug}:open` — set to the opened-at epoch-ms timestamp once
 *    the failure threshold is hit. `isOpen` compares `Date.now()` against this
 *    stored timestamp itself (rather than relying on Redis's own key-expiry
 *    timing) so the cooldown math is deterministic and trivially testable with
 *    a fake clock.
 *  - `whoami:breaker:{slug}:probe` — a `SET NX EX` admission lock. Once the
 *    open cooldown has elapsed, `isOpen` uses this to grant exactly ONE caller
 *    (across all replicas) permission to perform a single probing whoami call
 *    (by returning `false`, i.e. "not open, go ahead") — every other concurrent
 *    caller keeps observing `isOpen() === true` until the prober reports back
 *    via `recordSuccess`/`recordFailure`.
 *
 * KNOWN LIMITATION (security audit BAJO-3): `recordFailure` below does its
 * `INCR` and its `SET open` as two separate Redis round-trips, not one atomic
 * operation. If a concurrent `recordSuccess` for the same slug lands in the
 * window between those two commands, it can `DEL` the failures/open/probe
 * keys AFTER the `INCR` already pushed the count to the threshold but BEFORE
 * (or racing) the `SET open` — the net effect is the circuit can spuriously
 * flip back open right as it was being closed, for at most one
 * `OPEN_DURATION_MS` (30s) window. Impact is transitory and self-heals on the
 * next successful call; it does not affect correctness of individual auth
 * decisions (fail-closed still holds — see session-resolver.ts's ordering).
 * The robust fix is a single atomic Lua/MULTI script for INCR+conditional-SET,
 * but `ioredis-mock` (used by whoami-breaker.test.ts) does not execute Lua,
 * so that fix is deferred rather than implemented against a mocked Redis.
 * TODO(Fase 8.9): atomize INCR+open with Lua/MULTI once CI runs against a
 * real Redis (testcontainers).
 */

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS = 30_000;
// The Redis-level TTL on the `open` key is deliberately much longer than
// OPEN_DURATION_MS: the actual 30s cooldown is enforced by `isOpen` comparing
// `Date.now()` against the stored timestamp itself (see module doc comment).
// This TTL only exists as a garbage-collection safety net for a slug that
// stops receiving traffic entirely (so nothing ever calls recordSuccess/
// recordFailure again) — it must never be allowed to expire the key BEFORE
// our own cooldown math would, or a client with a mocked/virtual clock (real
// Redis TTLs and `Date.now()` can also drift apart under real clock skew)
// would see the open flag vanish prematurely.
const OPEN_KEY_SAFETY_TTL_SECONDS = 300;
const FAILURE_WINDOW_SECONDS = 60; // > OPEN_DURATION_MS/1000, so a failed probe's recordFailure still sees the prior count
const PROBE_LOCK_SECONDS = 10; // >= WHOAMI_TIMEOUT_MS (5s) so a crashed prober's slot self-heals quickly

const failuresKey = (slug: BrandSlug): string => `whoami:breaker:${slug}:failures`;
const openKey = (slug: BrandSlug): string => `whoami:breaker:${slug}:open`;
const probeKey = (slug: BrandSlug): string => `whoami:breaker:${slug}:probe`;

const redis = (): Redis => getRedis();

/**
 * The whoami call succeeded — clears all breaker state for `slug` (failure
 * counter, open flag, half-open probe lock). Fully closes the circuit.
 */
export async function recordSuccess(slug: BrandSlug): Promise<void> {
    await redis().del(failuresKey(slug), openKey(slug), probeKey(slug));
}

/**
 * Increments the failure counter (the `INCR` itself is atomic); at
 * `FAILURE_THRESHOLD` (3), (re)opens the circuit by stamping the current
 * time. Called again while already open (e.g. a failed half-open probe)
 * immediately re-stamps the open timestamp, restarting the cooldown — a
 * probe failure does not need to wait for the counter to reach the threshold
 * again as long as the failure window hasn't expired.
 *
 * BAJO-3 (known limitation, not fixed here): the `INCR` and the `SET open`
 * below are two separate commands, not one atomic transaction. A concurrent
 * `recordSuccess` for the same slug landing between them can clear the
 * breaker state right as this call is opening it, spuriously re-closing the
 * circuit for up to `OPEN_DURATION_MS`. See the module doc comment above for
 * the full rationale on why this isn't atomized yet.
 * TODO(Fase 8.9): atomize INCR+open with Lua/MULTI when CI has a real Redis
 * (testcontainers) — ioredis-mock doesn't execute Lua scripts.
 */
export async function recordFailure(slug: BrandSlug): Promise<void> {
    const client = redis();
    const count = await client.incr(failuresKey(slug));
    if (count === 1) {
        await client.expire(failuresKey(slug), FAILURE_WINDOW_SECONDS);
    }
    if (count >= FAILURE_THRESHOLD) {
        await client.set(openKey(slug), String(Date.now()), 'EX', OPEN_KEY_SAFETY_TTL_SECONDS);
    }
}

/**
 * The ONLY gate `session-resolver.ts` calls before touching the cache/network.
 * Returns `true` while the circuit is hard-open. Once the cooldown has
 * elapsed, grants exactly one caller (across all replicas) a `false` result
 * via `tryHalfOpen` so it can perform a single probing whoami call; every
 * other concurrent caller keeps getting `true` until the prober reports back.
 */
export async function isOpen(slug: BrandSlug): Promise<boolean> {
    const openedAtRaw = await redis().get(openKey(slug));
    if (openedAtRaw === null) return false;
    const openedAt = Number(openedAtRaw);
    if (!Number.isFinite(openedAt)) return false;
    if (Date.now() - openedAt < OPEN_DURATION_MS) return true;
    const grantedProbe = await tryHalfOpen(slug);
    return !grantedProbe;
}

/**
 * Half-open admission gate: `SET NX EX` so exactly one caller within
 * `PROBE_LOCK_SECONDS` wins the slot (returns `true`); every concurrent or
 * subsequent caller gets `false` until the lock expires or `recordSuccess`
 * clears it outright.
 */
export async function tryHalfOpen(slug: BrandSlug): Promise<boolean> {
    const result = await redis().set(probeKey(slug), '1', 'EX', PROBE_LOCK_SECONDS, 'NX');
    return result === 'OK';
}
