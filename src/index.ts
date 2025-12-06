import 'dotenv/config';
import http from 'node:http';

import { env } from './config/index.js';
import { createServer, attachCompanionSocket } from './server.js';

/**
 * Main entry point
 */
const start = async () => {
    const { app, brandRegistry } = createServer();

    const server = http.createServer(app);

    // Start listening
    server.listen(env.port, env.host, () => {
        console.log(`[companion-platform] Server listening on ${env.protocol}://${env.host}:${env.port}`);
        console.log(`[companion-platform] Public URL: ${env.protocol}://${env.publicHost}`);
        console.log(`[companion-platform] Brands: ${Array.from(brandRegistry.brands.keys()).join(', ')}`);
    });

    // Attach companion websocket
    attachCompanionSocket(server);

    // Graceful shutdown
    const shutdown = (signal: NodeJS.Signals) => {
        console.log(`[companion-platform] Received ${signal}. Shutting down...`);
        server.close((err) => {
            if (err) {
                console.error('[companion-platform] Error during shutdown:', err);
                process.exit(1);
            }
            console.log('[companion-platform] Server closed.');
            process.exit(0);
        });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
};

// Start the server
start().catch((error) => {
    console.error('[companion-platform] Failed to start server:', error);
    process.exit(1);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
    console.error('[companion-platform] Unhandled promise rejection:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('[companion-platform] Uncaught exception:', error);
    process.exit(1);
});
