import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cached, invalidate, clearLocalCache } from '../utils/cache';

// By default, we will mock the redis utility module
const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    keys: vi.fn(),
    del: vi.fn(),
};

vi.mock('../utils/redis', () => ({
    get redis() {
        return mockRedisActive ? mockRedis : null;
    }
}));

let mockRedisActive = false;

describe('Caching Utility', () => {
    beforeEach(() => {
        mockRedisActive = false;
        clearLocalCache();
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('Local In-Memory Cache Fallback (Redis is inactive)', () => {
        it('should fetch and cache value on first call, then return cached value', async () => {
            let callCount = 0;
            const fetchFn = async () => {
                callCount++;
                return 'fresh-data';
            };

            const val1 = await cached('test-key', 60, fetchFn);
            expect(val1).toBe('fresh-data');
            expect(callCount).toBe(1);

            const val2 = await cached('test-key', 60, fetchFn);
            expect(val2).toBe('fresh-data');
            expect(callCount).toBe(1); // Cached hit, fetchFn not called again
        });

        it('should respect TTL expiration', async () => {
            let callCount = 0;
            const fetchFn = async () => {
                callCount++;
                return `data-${callCount}`;
            };

            const val1 = await cached('ttl-key', 10, fetchFn); // TTL = 10s
            expect(val1).toBe('data-1');

            // Advance time by 9 seconds (within TTL)
            await vi.advanceTimersByTimeAsync(9 * 1000);
            const val2 = await cached('ttl-key', 10, fetchFn);
            expect(val2).toBe('data-1');

            // Advance time past TTL (total 11 seconds since creation)
            await vi.advanceTimersByTimeAsync(2 * 1000);
            const val3 = await cached('ttl-key', 10, fetchFn);
            expect(val3).toBe('data-2');
            expect(callCount).toBe(2);
        });

        it('should invalidate keys based on pattern matching', async () => {
            const fetcher = async () => 'data';

            await cached('user:123:profile', 60, fetcher);
            await cached('user:456:profile', 60, fetcher);
            await cached('bounty:789:detail', 60, fetcher);

            // Invalidate all user profiles
            await invalidate('user:*');

            // Fetch again and verify cache misses for users but hit for bounty
            let user1Fetched = false;
            let user2Fetched = false;
            let bountyFetched = false;

            await cached('user:123:profile', 60, async () => { user1Fetched = true; return 'user1'; });
            await cached('user:456:profile', 60, async () => { user2Fetched = true; return 'user2'; });
            await cached('bounty:789:detail', 60, async () => { bountyFetched = true; return 'bounty'; });

            expect(user1Fetched).toBe(true);
            expect(user2Fetched).toBe(true);
            expect(bountyFetched).toBe(false); // Hit! Not fetched again.
        });
    });

    describe('Upstash Redis Caching (Redis is active)', () => {
        beforeEach(() => {
            mockRedisActive = true;
        });

        it('should query Redis, and return cached value on cache hit', async () => {
            mockRedis.get.mockResolvedValueOnce(JSON.stringify('cached-redis-value'));

            const fetchFn = vi.fn().mockResolvedValue('fresh-redis-value');
            const res = await cached('redis-key', 60, fetchFn);

            expect(res).toBe('cached-redis-value');
            expect(mockRedis.get).toHaveBeenCalledWith('redis-key');
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('should call fetchFn and populate Redis on cache miss', async () => {
            mockRedis.get.mockResolvedValueOnce(null);
            mockRedis.set.mockResolvedValueOnce('OK');

            const fetchFn = vi.fn().mockResolvedValue({ status: 'fresh' });
            const res = await cached('miss-key', 120, fetchFn);

            expect(res).toEqual({ status: 'fresh' });
            expect(mockRedis.get).toHaveBeenCalledWith('miss-key');
            expect(fetchFn).toHaveBeenCalled();
            expect(mockRedis.set).toHaveBeenCalledWith(
                'miss-key',
                JSON.stringify({ status: 'fresh' }),
                { ex: 120 }
            );
        });

        it('should call keys scan and del on invalidate', async () => {
            mockRedis.keys.mockResolvedValueOnce(['match:1', 'match:2']);
            mockRedis.del.mockResolvedValueOnce(2);

            await invalidate('match:*');

            expect(mockRedis.keys).toHaveBeenCalledWith('match:*');
            expect(mockRedis.del).toHaveBeenCalledWith('match:1', 'match:2');
        });

        it('should not call del if no matching keys found during invalidate', async () => {
            mockRedis.keys.mockResolvedValueOnce([]);

            await invalidate('match:*');

            expect(mockRedis.keys).toHaveBeenCalledWith('match:*');
            expect(mockRedis.del).not.toHaveBeenCalled();
        });
    });
});
