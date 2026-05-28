import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Redis } from '@upstash/redis';

describe('Redis Client Utility', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('should export null if env vars are missing', async () => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;

        const { redis } = await import('../utils/redis');
        expect(redis).toBeNull();
    });

    it('should export a Redis instance if env vars are present', async () => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis-url.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

        const { redis } = await import('../utils/redis');
        expect(redis).not.toBeNull();
        expect(redis).toBeDefined();
        expect(redis).toBeInstanceOf(Redis);
    });
});
