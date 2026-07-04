import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { runWithContext, getContext, setUserId, logger, httpLogger } from './logger.js';

describe('log context (AsyncLocalStorage)', () => {
    it('propagates requestId/brand inside runWithContext', () => {
        runWithContext({ requestId: 'r1', brand: 'edo' }, () => {
            expect(getContext()?.requestId).toBe('r1');
            expect(getContext()?.brand).toBe('edo');
        });
    });

    it('is undefined outside of runWithContext', () => {
        expect(getContext()).toBeUndefined();
    });

    it('does not leak context across sibling calls', () => {
        runWithContext({ requestId: 'a' }, () => {
            expect(getContext()?.requestId).toBe('a');
        });
        runWithContext({ requestId: 'b' }, () => {
            expect(getContext()?.requestId).toBe('b');
        });
        expect(getContext()).toBeUndefined();
    });

    it('propagates across async boundaries inside the same run', async () => {
        await runWithContext({ requestId: 'async-1' }, async () => {
            await Promise.resolve();
            expect(getContext()?.requestId).toBe('async-1');
        });
    });

    it('setUserId records the user id on the active context', () => {
        runWithContext({ requestId: 'r2' }, () => {
            setUserId('u9');
            expect(getContext()?.userId).toBe('u9');
        });
    });

    it('setUserId is a no-op outside of runWithContext', () => {
        expect(() => setUserId('u9')).not.toThrow();
        expect(getContext()).toBeUndefined();
    });
});

describe('logger (Pino + mixin)', () => {
    it('injects the active AsyncLocalStorage context into log lines', () => {
        const chunks: string[] = [];
        const writeSpy = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: unknown) => {
                chunks.push(String(chunk));
                return true;
            });
        const previousLevel = logger.level;
        logger.level = 'info';
        try {
            runWithContext({ requestId: 'r4', brand: 'edo', userId: 'u2' }, () => {
                logger.info('hello');
            });
        } finally {
            logger.level = previousLevel;
            writeSpy.mockRestore();
        }
        expect(chunks).toHaveLength(1);
        const line = JSON.parse(chunks[0]);
        expect(line.requestId).toBe('r4');
        expect(line.brand).toBe('edo');
        expect(line.userId).toBe('u2');
        expect(line.msg).toBe('hello');
    });

    it('does not attach requestId/brand/userId when logging outside of runWithContext', () => {
        const chunks: string[] = [];
        const writeSpy = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: unknown) => {
                chunks.push(String(chunk));
                return true;
            });
        const previousLevel = logger.level;
        logger.level = 'info';
        try {
            logger.info('bare');
        } finally {
            logger.level = previousLevel;
            writeSpy.mockRestore();
        }
        const line = JSON.parse(chunks[0]);
        expect(line.requestId).toBeUndefined();
        expect(line.brand).toBeUndefined();
        expect(line.userId).toBeUndefined();
    });
});

describe('httpLogger (pino-http middleware)', () => {
    it('uses the incoming x-request-id header as req.id', async () => {
        const app = express();
        app.use(httpLogger);
        app.get('/', (req, res) => res.json({ id: req.id }));
        const res = await request(app).get('/').set('x-request-id', 'incoming-id-123');
        expect(res.body.id).toBe('incoming-id-123');
    });

    it('generates a requestId via crypto.randomUUID() when the header is absent', async () => {
        const app = express();
        app.use(httpLogger);
        app.get('/', (req, res) => res.json({ id: req.id }));
        const res = await request(app).get('/');
        expect(typeof res.body.id).toBe('string');
        expect(res.body.id.length).toBeGreaterThan(0);
        // UUID v4 shape
        expect(res.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
});
