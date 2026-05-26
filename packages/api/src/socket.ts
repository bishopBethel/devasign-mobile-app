import { Server as SocketIOServer } from 'socket.io';
import { verify } from 'hono/jwt';
import { db } from './db';
import { bounties } from './db/schema';
import { eq, or, and, ne } from 'drizzle-orm';


let io: SocketIOServer | null = null;

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

        socket.on('disconnect', (reason) => {
            console.log(`User ${user.username || user.id} (socket ${socket.id}) disconnected. Reason: ${reason}`);
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
