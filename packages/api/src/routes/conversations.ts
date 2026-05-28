import { Hono } from 'hono';
import { db } from '../db';
import { bounties, messages, users } from '../db/schema';
import { eq, or, and, ne, isNotNull, desc, isNull, count } from 'drizzle-orm';
import { Variables } from '../middleware/auth';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

const conversationsRoute = new Hono<{ Variables: Variables }>();

const bountyIdSchema = z.object({
    bountyId: z.string().uuid(),
});

const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

/**
 * GET /api/conversations
 * Returns a list of active conversations (bounties where user is creator or assignee and messaging is enabled),
 * including the last message preview, other participant details, and unread message count.
 */
conversationsRoute.get('/', async (c) => {
    try {
        const user = c.get('user');
        if (!user || !user.id) {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        // 1. Fetch active bounties where current user is creator or assignee,
        // assigneeId is not null, and status is neither completed nor cancelled.
        const activeBounties = await db
            .select({
                id: bounties.id,
                title: bounties.title,
                repoOwner: bounties.repoOwner,
                repoName: bounties.repoName,
                status: bounties.status,
                creatorId: bounties.creatorId,
                assigneeId: bounties.assigneeId,
            })
            .from(bounties)
            .where(
                and(
                    or(
                        eq(bounties.creatorId, user.id),
                        eq(bounties.assigneeId, user.id)
                    ),
                    isNotNull(bounties.assigneeId),
                    ne(bounties.status, 'completed'),
                    ne(bounties.status, 'cancelled')
                )
            );

        const conversations = [];

        // 2. Fetch the other participant's details, the last message, and the unread count for each conversation
        for (const bounty of activeBounties) {
            const otherParticipantId = bounty.creatorId === user.id ? bounty.assigneeId : bounty.creatorId;

            if (!otherParticipantId) {
                continue; // Safety fallback
            }

            // Fetch other participant profile details
            const otherParticipant = await db.query.users.findFirst({
                where: eq(users.id, otherParticipantId),
                columns: {
                    id: true,
                    username: true,
                    avatarUrl: true,
                }
            });

            if (!otherParticipant) {
                continue; // If other participant no longer exists, skip this conversation
            }

            // Fetch last message preview
            const lastMessage = await db.query.messages.findFirst({
                where: eq(messages.bountyId, bounty.id),
                orderBy: [desc(messages.createdAt)]
            });

            // Fetch unread count for the current user
            const [unreadCountResult] = await db
                .select({ value: count() })
                .from(messages)
                .where(
                    and(
                        eq(messages.bountyId, bounty.id),
                        eq(messages.recipientId, user.id),
                        isNull(messages.readAt)
                    )
                );

            conversations.push({
                bountyId: bounty.id,
                title: bounty.title,
                repoOwner: bounty.repoOwner,
                repoName: bounty.repoName,
                status: bounty.status,
                otherParticipant: {
                    id: otherParticipant.id,
                    username: otherParticipant.username,
                    avatarUrl: otherParticipant.avatarUrl,
                },
                lastMessage: lastMessage ? {
                    id: lastMessage.id,
                    content: lastMessage.content,
                    senderId: lastMessage.senderId,
                    createdAt: lastMessage.createdAt,
                    readAt: lastMessage.readAt,
                } : null,
                unreadCount: unreadCountResult?.value || 0,
            });
        }

        // Sort conversations by last message's createdAt descending
        conversations.sort((a, b) => {
            const timeA = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
            const timeB = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
            return timeB - timeA;
        });

        return c.json(conversations);
    } catch (error: any) {
        console.error('Failed to fetch conversations:', error);
        return c.json({ error: 'Failed to fetch conversations', details: error.message }, 500);
    }
});

/**
 * GET /api/conversations/:bountyId/messages
 * Returns a paginated list of messages for the specified bounty conversation.
 * Verifies that the authenticated user is an active participant of the bounty (creator or assignee).
 */
conversationsRoute.get(
    '/:bountyId/messages',
    zValidator('param', bountyIdSchema),
    zValidator('query', paginationSchema),
    async (c) => {
        try {
            const user = c.get('user');
            if (!user || !user.id) {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            const { bountyId } = c.req.valid('param');
            const { page, limit } = c.req.valid('query');
            const offset = (page - 1) * limit;

            // 1. Fetch bounty details to verify existence and check user authorization
            const bounty = await db.query.bounties.findFirst({
                where: eq(bounties.id, bountyId),
            });

            if (!bounty) {
                return c.json({ error: 'Bounty not found' }, 404);
            }

            // Verify user is participant of the bounty (creator or assignee)
            if (bounty.creatorId !== user.id && bounty.assigneeId !== user.id) {
                return c.json({ error: 'Forbidden. You are not an active participant of this bounty.' }, 403);
            }

            // 2. Fetch paginated messages sorted by createdAt descending
            const results = await db
                .select()
                .from(messages)
                .where(eq(messages.bountyId, bountyId))
                .orderBy(desc(messages.createdAt))
                .limit(limit)
                .offset(offset);

            // 3. Get total count of messages for pagination metadata
            const [totalCountResult] = await db
                .select({ value: count() })
                .from(messages)
                .where(eq(messages.bountyId, bountyId));

            const total = totalCountResult?.value || 0;

            return c.json({
                data: results,
                meta: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                },
            });
        } catch (error: any) {
            console.error('Failed to fetch messages:', error);
            return c.json({ error: 'Failed to fetch messages', details: error.message }, 500);
        }
    }
);

export default conversationsRoute;
