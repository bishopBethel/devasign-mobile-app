import { redis } from './redis';

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

const localCache = new Map<string, CacheEntry<any>>();

/**
 * Converts a Redis glob pattern (e.g. "user:*") into a JavaScript RegExp.
 */
function globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(regexStr);
}

/**
 * Caches the result of an asynchronous function fetchFn under the specified key.
 * Backed by Upstash Redis if active, falling back to a memory Map with TTL support.
 * 
 * @param key Unique key to identify the cached value.
 * @param ttlInSeconds Cache lifespan in seconds.
 * @param fetchFn Asynchronous fallback function to execute on a cache miss.
 */
export async function cached<T>(
    key: string,
    ttlInSeconds: number,
    fetchFn: () => Promise<T>
): Promise<T> {
    if (redis) {
        try {
            const cachedValue = await redis.get<any>(key);
            if (cachedValue !== null) {
                if (typeof cachedValue === 'string') {
                    try {
                        return JSON.parse(cachedValue) as T;
                    } catch {
                        return cachedValue as unknown as T;
                    }
                }
                return cachedValue as T;
            }
        } catch (error) {
            console.error(`Error reading from Redis cache for key "${key}":`, error);
        }
    } else {
        const entry = localCache.get(key);
        if (entry) {
            if (entry.expiresAt > Date.now()) {
                return entry.value as T;
            }
            localCache.delete(key); // Clean up expired memory cache entry
        }
    }

    // Cache miss
    const freshValue = await fetchFn();

    if (redis) {
        try {
            const serialized = typeof freshValue === 'string' ? freshValue : JSON.stringify(freshValue);
            await redis.set(key, serialized, { ex: ttlInSeconds });
        } catch (error) {
            console.error(`Error writing to Redis cache for key "${key}":`, error);
        }
    } else {
        localCache.set(key, {
            value: freshValue,
            expiresAt: Date.now() + ttlInSeconds * 1000,
        });
    }

    return freshValue;
}

/**
 * Invalidates cache keys matching a specific glob pattern.
 * Supports Redis pattern deletion as well as in-memory wildcard matching.
 * 
 * @param pattern Wildcard pattern to match (e.g. "bounty:recommended:*" or "user:123").
 */
export async function invalidate(pattern: string): Promise<void> {
    if (redis) {
        try {
            const keys = await redis.keys(pattern);
            if (keys && keys.length > 0) {
                await redis.del(...keys);
            }
        } catch (error) {
            console.error(`Error invalidating keys for pattern "${pattern}" in Redis:`, error);
        }
    } else {
        const regex = globToRegex(pattern);
        for (const key of localCache.keys()) {
            if (regex.test(key)) {
                localCache.delete(key);
            }
        }
    }
}

/**
 * Helper function primarily intended for testing purposes to inspect/reset local cache.
 */
export function clearLocalCache(): void {
    localCache.clear();
}
