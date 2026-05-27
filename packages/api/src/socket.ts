import { Server as SocketIOServer } from 'socket.io';
import { verify } from 'hono/jwt';
import { db } from './db';
import { bounties, messages } from './db/schema';
import { eq, or, and, ne } from 'drizzle-orm';
import { sanitizeHTML } from './utils/sanitize';
import { sendPushNotification } from './services/notifications';

let io: SocketIOServer | null = null;

// Track connected users in-memory for efficient online checks (userId -> socketIds[])
export const activeUsers = new Map<string, string[]>();

export interface SocketData {
    user: {
        id: string;
        username: string | null;
    };
}

/**
 * Initializes the Socket.io WebSocket server on the given HTTP/HTTPS server instance.
 * Sets up CORS and registers the JWT authentication middleware and connection handlers.
 */
export function initSocketServer(server: any): SocketIOServer {
    if (io) {
        console.warn('Socket.io server is already initialized.');
        return io;
    }

    io = new SocketIOServer(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            credentials: true
        }
    });

    // JWT Authentication Middleware
    io.use(async (socket, next) => {
        try {
            // Get token from handshake auth or Authorization header
            let token = socket.handshake.auth?.token;
            
            if (!token && socket.handshake.headers?.authorization) {
                const authHeader = socket.handshake.headers.authorization;
                if (authHeader.startsWith('Bearer ')) {
                    token = authHeader.substring(7);
                } else {
                    token = authHeader;
                }
            }

            if (!token) {
                return next(new Error('Authentication error: Missing token'));
            }

            const rawPublicKey = process.env.JWT_PUBLIC_KEY;
            if (!rawPublicKey) {
                console.error('Socket Auth Error: JWT_PUBLIC_KEY is not defined.');
                return next(new Error('Authentication error: Server configuration error'));
            }

            const publicKey = rawPublicKey.replace(/\\n/g, '\n');

            // Verify the token using the RS256 algorithm (matching authMiddleware)
            const payload = await verify(token, publicKey, 'RS256') as any;

            if (!payload || !payload.sub) {
                return next(new Error('Authentication error: Invalid token payload'));
            }

            // Store user data in socket.data
            socket.data.user = {
                id: payload.sub,
                username: payload.username || null,
            };

            next();
        } catch (error) {
            console.error('Socket.io authentication middleware error:', error);
            next(new Error('Authentication error: Invalid or expired token'));
        }
    });

    // Connection handler
    io.on('connection', async (socket) => {
        const user = socket.data.user;
        if (!user || !user.id) {
            console.warn(`Socket connected without authenticated user data: ${socket.id}`);
            socket.disconnect(true);
            return;
        }

        console.log(`User ${user.username || user.id} connected via socket ${socket.id}`);

        // Register user connection in activeUsers tracking map
        const socketIds = activeUsers.get(user.id) || [];
        socketIds.push(socket.id);
        activeUsers.set(user.id, socketIds);

        try {
            // Query active bounties where the user is creator or assignee
            const activeBounties = await db
                .select({ id: bounties.id })
                .from(bounties)
                .where(
                    and(
                        or(
                            eq(bounties.creatorId, user.id),
                            eq(bounties.assigneeId, user.id)
                        ),
                        ne(bounties.status, 'completed'),
                        ne(bounties.status, 'cancelled')
                    )
                );

            // Join each active bounty room
            for (const bounty of activeBounties) {
                const roomName = `bounty:${bounty.id}`;
                await socket.join(roomName);
                console.log(`Socket ${socket.id} (User ${user.id}) joined room ${roomName}`);
            }
        } catch (error) {
            console.error(`Error joining active bounty rooms for user ${user.id}:`, error);
        }

        // Real-time Messaging Handler: Listen for messages sent by the client
        socket.on('message:send', async (data: { bountyId: string; content: string }, callback?: any) => {
            try {
                const { bountyId, content } = data;
                if (!bountyId || !content || typeof content !== 'string' || content.trim() === '') {
                    throw new Error('Invalid parameters: bountyId and content are required.');
                }

                // 1. Fetch bounty and check existence
                const bounty = await db.query.bounties.findFirst({
                    where: eq(bounties.id, bountyId)
                });

                if (!bounty) {
                    throw new Error('Bounty not found.');
                }

                // 2. Validate sender is either creator or assignee
                const isCreator = bounty.creatorId === user.id;
                const isAssignee = bounty.assigneeId === user.id;

                if (!isCreator && !isAssignee) {
                    throw new Error('Unauthorized: You are not an active participant of this bounty.');
                }

                // 3. Determine recipientId (the other active participant of the bounty)
                const recipientId = isCreator ? bounty.assigneeId : bounty.creatorId;
                if (!recipientId) {
                    throw new Error('No recipient found. Messages can only be sent once a developer is assigned to the bounty.');
                }

                // 4. Sanitize message content to completely mitigate Stored XSS
                const sanitizedContent = sanitizeHTML(content);

                // 5. Persist the sanitized message to PostgreSQL database
                const [newMessage] = await db.insert(messages).values({
                    bountyId,
                    senderId: user.id,
                    recipientId,
                    content: sanitizedContent
                }).returning();

                // 6. Broadcast the message to all clients in the bounty room
                io?.to(`bounty:${bountyId}`).emit('message:new', newMessage);

                // 7. Check if the recipient is online
                const isRecipientOnline = activeUsers.has(recipientId);

                // 8. Trigger push notification for offline recipients
                if (!isRecipientOnline) {
                    sendPushNotification({
                        recipientId,
                        title: `New message on bounty: ${bounty.title}`,
                        body: `${user.username || 'A developer'} sent you a message: ${sanitizedContent}`,
                        data: {
                            bountyId,
                            messageId: newMessage.id
                        }
                    }).catch(err => {
                        console.error('Failed to trigger push notification:', err);
                    });
                }

                // Call client acknowledgment if provided
                if (typeof callback === 'function') {
                    callback({ success: true, message: newMessage });
                }
            } catch (error: any) {
                console.error('Error handling message:send:', error);
                if (typeof callback === 'function') {
                    callback({ success: false, error: error.message });
                } else {
                    socket.emit('message:error', { error: error.message });
                }
            }
        });

        // Disconnect handler
        socket.on('disconnect', (reason) => {
            console.log(`User ${user.username || user.id} (socket ${socket.id}) disconnected. Reason: ${reason}`);
            
            // Remove socket from tracking map
            const currentSocketIds = activeUsers.get(user.id) || [];
            const remaining = currentSocketIds.filter(id => id !== socket.id);
            if (remaining.length > 0) {
                activeUsers.set(user.id, remaining);
            } else {
                activeUsers.delete(user.id);
            }
        });
    });

    console.log('Socket.io server successfully initialized with JWT auth.');
    return io;
}

/**
 * Returns the initialized Socket.io server instance.
 * Throws an error if the server has not been initialized yet.
 */
export function getIO(): SocketIOServer {
    if (!io) {
        throw new Error('Socket.io server has not been initialized. Call initSocketServer(server) first.');
    }
    return io;
}
