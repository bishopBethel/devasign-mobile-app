import { redis } from './redis';

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

const localCache = new Map<string, CacheEntry<any>>();

/**
 * Escapes glob special wildcard characters (*, ?, [, ], \) in a string segment
 * to safely interpolate user-controlled inputs into cache invalidation patterns.
 */
export function escapeGlob(segment: string): string {
    return segment.replace(/[*?[\]\\]/g, '\\$&');
}

/**
 * Converts a Redis glob pattern (e.g. "user:*") into a JavaScript RegExp,
 * correctly supporting backslash escaping of wildcards.
 */
function globToRegex(pattern: string): RegExp {
    let regexStr = '^';
    let i = 0;
    while (i < pattern.length) {
        const char = pattern[i];
        if (char === '\\') {
            // Escaped character - treat the next character literally
            const nextChar = pattern[i + 1];
            if (nextChar !== undefined) {
                regexStr += nextChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                i += 2;
            } else {
                regexStr += '\\\\';
                i++;
            }
        } else if (char === '*') {
            regexStr += '.*';
            i++;
        } else if (char === '?') {
            regexStr += '.';
            i++;
        } else {
            regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            i++;
        }
    }
    regexStr += '$';
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

export type InvalidatePattern = 
    | string 
    | { prefix: string; parts: string[]; suffix?: string };

/**
 * Invalidates cache keys matching a specific glob pattern.
 * Supports Redis pattern deletion as well as in-memory wildcard matching.
 * 
 * @param pattern Wildcard pattern to match (e.g. "bounty:recommended:*") or a structured
 *                object that escapes user-controlled segments internally.
 *                Example structured usage: `invalidate({ prefix: "user:", parts: [userId], suffix: ":*" })`
 */
export async function invalidate(pattern: InvalidatePattern): Promise<void> {
    let finalPattern: string;
    if (typeof pattern === 'object') {
        const escapedParts = pattern.parts.map(escapeGlob);
        finalPattern = pattern.prefix + escapedParts.join(':') + (pattern.suffix ?? '');
    } else {
        finalPattern = pattern;
    }

    // Safety Guard: Prevent cache destruction from empty, wildcard-only, or overly broad patterns
    const stripped = finalPattern.replace(/[*?\\]/g, '');
    if (stripped.length === 0) {
        throw new Error(`Invalid invalidation pattern: "${finalPattern}" is too broad and lacks literal characters.`);
    }

    if (redis) {
        try {
            let cursor = '0';
            do {
                const [nextCursor, keys] = await redis.scan(cursor, {
                    match: finalPattern,
                    count: 100,
                });
                cursor = String(nextCursor);
                if (keys && keys.length > 0) {
                    await redis.del(...keys);
                }
            } while (cursor !== '0');
        } catch (error) {
            console.error(`Error invalidating keys for pattern "${finalPattern}" in Redis:`, error);
        }
    } else {
        const regex = globToRegex(finalPattern);
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
