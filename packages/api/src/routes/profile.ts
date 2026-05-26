import { Hono } from 'hono';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { githubService } from '../services/github';
import { Variables } from '../middleware/auth';
import { invalidateRecommendedCache } from './bounties';

const profileRoute = new Hono<{ Variables: Variables }>();

/**
 * POST /profile/refresh-github
 * Re-syncs GitHub profile & tech stack data and invalidates recommendations cache.
 */
profileRoute.post('/refresh-github', async (c) => {
    try {
        const user = c.get('user');
        
        if (!user || !user.id || !user.username) {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        const body = await c.req.json().catch(() => ({}));
        const githubAccessToken = body.githubAccessToken || body.accessToken || body.token || c.req.header('x-github-token');

        if (!githubAccessToken) {
            return c.json({ error: 'GitHub access token is required' }, 400);
        }

        // 1. Fetch user profile from GitHub
        const githubUser = await githubService.getUserProfile(githubAccessToken);
        if (!githubUser) {
            return c.json({ error: 'Failed to fetch GitHub profile' }, 500);
        }

        if (githubUser.login.toLowerCase() !== user.username.toLowerCase()) {
            return c.json({ error: 'Provided GitHub token belongs to a different user' }, 403);
        }

        // 2. Fetch tech stack data from GitHub
        const techStack = await githubService.analyzeTechStack(githubAccessToken);

        // 3. Update the user in the database
        const [updatedUser] = await db.update(users)
            .set({
                avatarUrl: githubUser.avatar_url,
                ...(githubUser.email ? { email: githubUser.email } : {}),
                publicRepos: githubUser.public_repos || 0,
                techStack: techStack,
                updatedAt: new Date(),
            })
            .where(eq(users.id, user.id))
            .returning();

        if (!updatedUser) {
            return c.json({ error: 'User not found in database' }, 404);
        }

        // 4. Invalidate recommendations cache
        invalidateRecommendedCache(user.id);

        return c.json({
            success: true,
            user: {
                id: updatedUser.id,
                username: updatedUser.username,
                avatarUrl: updatedUser.avatarUrl,
                email: updatedUser.email,
                publicRepos: updatedUser.publicRepos,
                techStack: updatedUser.techStack,
            }
        });
    } catch (error: any) {
        console.error('Failed to refresh GitHub profile:', error);
        return c.json({ error: 'Failed to refresh GitHub profile', details: error.message }, 500);
    }
});

export default profileRoute;
