import { Redis } from '@upstash/redis';

let redis: Redis | null = null;

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (url && token) {
    redis = new Redis({
        url,
        token,
    });
} else {
    // Gracefully handle in case Redis is not configured yet
    if (process.env.NODE_ENV === 'development') {
        console.warn(
            '⚠ Upstash Redis environment variables (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN) are missing. Redis client will not be active.'
        );
    }
}

export { redis };
