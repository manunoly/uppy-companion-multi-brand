import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

/**
 * Per-request/per-task context propagated implicitly through async calls via
 * AsyncLocalStorage, so call sites don't need to thread requestId/brand/userId
 * through every function signature just to log them.
 */
export interface LogContext {
    requestId?: string;
    brand?: string;
    userId?: string;
}

const als = new AsyncLocalStorage<LogContext>();

/**
 * Runs `fn` with `ctx` available to `getContext()`/`logger.*` for the
 * duration of its (possibly async) execution. Nested calls get their own
 * independent frame; the outer context is restored once `fn` settles.
 */
export const runWithContext = <T>(ctx: LogContext, fn: () => T): T => als.run(ctx, fn);

/** Returns the active log context, or `undefined` outside of `runWithContext`. */
export const getContext = (): LogContext | undefined => als.getStore();

/**
 * Records the authenticated user id on the currently active context (set by
 * `attachUser` once a session resolves). No-op outside of `runWithContext`
 * (e.g. code running before the request-scoped context is opened).
 */
export const setUserId = (userId: string): void => {
    const ctx = als.getStore();
    if (ctx) ctx.userId = userId;
};

// Quiet during the Vitest run so `pnpm test` output stays readable; individual
// tests can still opt in by setting `logger.level` for the duration of the test.
const defaultLevel = process.env.VITEST ? 'silent' : (process.env.LOG_LEVEL ?? 'info');

/**
 * Shared Pino logger. `mixin()` merges the active AsyncLocalStorage context
 * (requestId/brand/userId) into every log line without callers having to
 * pass it explicitly.
 */
export const logger = pino(
    {
        level: defaultLevel,
        mixin() {
            return getContext() ?? {};
        },
    },
    // Write through the standard `process.stdout` stream (instead of Pino's
    // default sonic-boom fd destination) so log output stays testable via
    // `vi.spyOn(process.stdout, 'write')` and interleaves predictably with
    // other stdout writers (e.g. test runners) in this app's modest workload.
    process.stdout,
);

/**
 * Express middleware (pino-http) that logs each request/response and assigns
 * `req.id`. Prefers an inbound `x-request-id` (useful behind a proxy/LB that
 * generates one) and falls back to a fresh UUID otherwise.
 */
export const httpLogger = pinoHttp({
    logger,
    genReqId: (req) => {
        const header = req.headers['x-request-id'];
        if (typeof header === 'string' && header.length > 0) return header;
        return randomUUID();
    },
});
