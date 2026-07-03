import type { EnvConfig } from '../config/env.schema.js';

export const makeValidEnv = (overrides: Partial<EnvConfig> = {}): EnvConfig => ({
    port: 3020,
    host: '0.0.0.0',
    protocol: 'http',
    publicHost: 'localhost:3020',
    secret: 'test-secret-value-1234567890',
    healthCheckKey: undefined,
    redisUrl: 'redis://localhost:6379',
    filePath: '/tmp/',
    ...overrides,
});
