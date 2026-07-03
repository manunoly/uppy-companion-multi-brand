import { Redis } from 'ioredis';
import { env } from '../config/index.js';
import { logger } from './logger.js';

let client: Redis | null = null;

/**
 * Returns the shared Redis client, lazily created on first use so importing
 * this module never opens a connection by itself (only the first `getRedis()`
 * call does). Backed by `env.redisUrl` — Railway's Redis plugin in production,
 * a local dev instance by default otherwise.
 */
export const getRedis = (): Redis => {
    if (!client) {
        const instance = new Redis(env.redisUrl, { maxRetriesPerRequest: 2 });
        instance.on('error', (err) => {
            logger.error({ err }, '[redis] connection error');
        });
        client = instance;
    }
    return client;
};

/**
 * Closes the shared client (if one was ever created) and clears the
 * singleton, so a subsequent `getRedis()` call builds a fresh connection.
 * Safe to call multiple times or when no client exists yet.
 */
export const closeRedis = async (): Promise<void> => {
    if (!client) return;
    const instance = client;
    client = null;
    await instance.quit();
};
