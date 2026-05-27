import { Hono } from 'hono';
import { db } from '../db';
import { bounties, messages, users } from '../db/schema';
import { eq, or, and, ne, isNotNull, desc, isNull, count } from 'drizzle-orm';
import { Variables } from '../middleware/auth';

const conversationsRoute = new Hono<{ Variables: Variables }>();

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

export default conversationsRoute;
