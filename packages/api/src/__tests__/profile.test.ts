import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../app';
import { githubService } from '../services/github';
import { db } from '../db';
import * as jwt from 'hono/jwt';
import { invalidateRecommendedCache } from '../routes/bounties';

// Mock dependencies
vi.mock('../services/github', () => ({
    githubService: {
        getUserProfile: vi.fn(),
        analyzeTechStack: vi.fn(),
    },
}));

vi.mock('../routes/bounties', async (importOriginal) => {
    const original = await importOriginal<typeof import('../routes/bounties')>();
    return {
        ...original,
        invalidateRecommendedCache: vi.fn(),
    };
});

vi.mock('../db', () => ({
    db: {
        update: vi.fn(() => ({
            set: vi.fn(() => ({
                where: vi.fn(() => ({
                    returning: vi.fn(() => [{
                        id: 'user-123',
                        username: 'testuser',
                        avatarUrl: 'https://synced.avatar.url',
                        email: 'test@example.com',
                        publicRepos: 42,
                        techStack: ['React', 'Next.js'],
                    }])
                })),
            })),
        })),
    },
}));

vi.mock('hono/jwt', async (importOriginal) => {
    const original = await importOriginal<typeof import('hono/jwt')>();
    return {
        ...original,
        verify: vi.fn(),
    };
});

describe('Profile Routes (Refresh GitHub)', () => {
    let app: any;

    beforeEach(() => {
        vi.clearAllMocks();
        app = createApp();
        process.env.JWT_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----";
    });

    describe('POST /api/profile/refresh-github', () => {
        it('should return 401 if unauthorized', async () => {
            const res = await app.request('/api/profile/refresh-github', {
                method: 'POST',
                body: JSON.stringify({ accessToken: 'fake-token' }),
            });
            expect(res.status).toBe(401);
        });

        it('should return 400 if GitHub access token is missing', async () => {
            (jwt.verify as any).mockResolvedValue({ sub: 'user-123', username: 'testuser' });

            const req = new Request('http://localhost/api/profile/refresh-github', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer valid_token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({}),
            });
            const res = await app.fetch(req);

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toBe('GitHub access token is required');
        });

        it('should successfully refresh profile and tech stack and invalidate recommendations cache', async () => {
            (jwt.verify as any).mockResolvedValue({ sub: 'user-123', username: 'testuser' });

            const mockGithubUser = {
                id: 12345,
                login: 'testuser',
                email: 'test@example.com',
                avatar_url: 'https://synced.avatar.url',
                public_repos: 42,
            };

            const mockTechStack = ['React', 'Next.js'];

            (githubService.getUserProfile as any).mockResolvedValue(mockGithubUser);
            (githubService.analyzeTechStack as any).mockResolvedValue(mockTechStack);

            const req = new Request('http://localhost/api/profile/refresh-github', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer valid_token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ githubAccessToken: 'valid-github-token' }),
            });
            const res = await app.fetch(req);

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.user.publicRepos).toBe(42);
            expect(body.user.email).toBe('test@example.com');
            expect(body.user.avatarUrl).toBe('https://synced.avatar.url');
            expect(body.user.techStack).toEqual(['React', 'Next.js']);

            expect(db.update).toHaveBeenCalled();
            expect(githubService.getUserProfile).toHaveBeenCalledWith('valid-github-token');
            expect(githubService.analyzeTechStack).toHaveBeenCalledWith('valid-github-token');
            expect(invalidateRecommendedCache).toHaveBeenCalledWith('user-123');
        });

        it('should return 500 if github profile fetch fails', async () => {
            (jwt.verify as any).mockResolvedValue({ sub: 'user-123', username: 'testuser' });
            (githubService.getUserProfile as any).mockRejectedValue(new Error('GitHub API Error'));

            const req = new Request('http://localhost/api/profile/refresh-github', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer valid_token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ accessToken: 'valid-github-token' }),
            });
            const res = await app.fetch(req);

            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.error).toBe('Failed to refresh GitHub profile');
            expect(body.details).toBe('GitHub API Error');
        });

        it('should return 403 if the GitHub token belongs to a different user', async () => {
            (jwt.verify as any).mockResolvedValue({ sub: 'user-123', username: 'testuser' });

            const mockDifferentGithubUser = {
                id: 54321,
                login: 'differentuser',
                email: 'diff@example.com',
                avatar_url: 'https://synced.avatar.url',
                public_repos: 10,
            };

            (githubService.getUserProfile as any).mockResolvedValue(mockDifferentGithubUser);

            const req = new Request('http://localhost/api/profile/refresh-github', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer valid_token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ githubAccessToken: 'valid-github-token' }),
            });
            const res = await app.fetch(req);

            expect(res.status).toBe(403);
            const body = await res.json();
            expect(body.error).toBe('Provided GitHub token belongs to a different user');
        });
    });
});
