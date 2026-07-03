import 'dotenv/config';
import http from 'node:http';

import { env } from './config/index.js';
import { createServer, attachCompanionSocket } from './server.js';
import { closeRedis } from './lib/redis.js';
import { logger } from './lib/logger.js';

/**
 * Main entry point
 */
const start = async () => {
    const { app, brandRegistry, setShuttingDown } = createServer();

    const server = http.createServer(app);

    // Start listening
    server.listen(env.port, env.host, () => {
        logger.info({ url: `${env.protocol}://${env.host}:${env.port}` }, '[companion-platform] Server listening');
        logger.info({ url: `${env.protocol}://${env.publicHost}` }, '[companion-platform] Public URL');
        logger.info({ brands: Object.keys(brandRegistry) }, '[companion-platform] Brands loaded');
    });

    // Attach companion websocket
    attachCompanionSocket(server);

    // Graceful shutdown: flip readiness/liveness to 503 immediately (ahead of
    // the orchestrator draining traffic away from us), stop accepting new
    // connections, close shared resources (Redis), and force-exit if
    // draining takes too long.
    //
    // Caveat: `@uppy/companion`'s socket() attaches a `ws` WebSocketServer
    // directly to `server` but doesn't return a handle to it, so there is no
    // public API to call `.close()` on it. "Closing the WS" in practice means
    // `server.close()` stops accepting *new* upgrade requests; any already
    // -upgraded long-lived WS connections are only terminated when the
    // process actually exits (the force-exit timer below is the backstop).
    let shuttingDownStarted = false;
    const shutdown = (signal: NodeJS.Signals) => {
        if (shuttingDownStarted) return;
        shuttingDownStarted = true;

        logger.info({ signal }, '[companion-platform] Received shutdown signal');
        setShuttingDown(true);

        // Safety net: long-lived WS connections aren't tracked by
        // server.close()'s drain, so it may never invoke its callback.
        const forceExitTimer = setTimeout(() => {
            logger.warn('[companion-platform] Graceful shutdown timed out; forcing exit');
            process.exit(0);
        }, 10_000);
        forceExitTimer.unref();

        server.close((err) => {
            if (err) {
                logger.error({ err }, '[companion-platform] Error during shutdown');
            } else {
                logger.info('[companion-platform] Server closed.');
            }
            closeRedis()
                .catch((closeErr) => logger.error({ err: closeErr }, '[companion-platform] Error closing Redis'))
                .finally(() => process.exit(err ? 1 : 0));
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
};

// Start the server
start().catch((error) => {
    logger.error({ err: error }, '[companion-platform] Failed to start server');
    process.exit(1);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '[companion-platform] Unhandled promise rejection');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error({ err: error }, '[companion-platform] Uncaught exception');
    process.exit(1);
});
