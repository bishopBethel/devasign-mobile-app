import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, Server as HTTPServer } from 'http';
import { io as Client } from 'socket.io-client';
import { verify } from 'hono/jwt';
import { initSocketServer, activeUsers } from '../socket';
import { sendPushNotification } from '../services/notifications';
import type { AddressInfo } from 'net';

// Mock hono/jwt verify
vi.mock('hono/jwt', () => ({
    verify: vi.fn(),
}));

// Mock notifications service
vi.mock('../services/notifications', () => ({
    sendPushNotification: vi.fn().mockResolvedValue(undefined),
}));

const mockWhere = vi.fn();
const mockFrom = vi.fn().mockReturnValue({
    where: mockWhere,
});
const mockSelect = vi.fn().mockReturnValue({
    from: mockFrom,
});

const mockFindFirst = vi.fn();
const mockFindFirstMessage = vi.fn();
const mockReturning = vi.fn();
const mockInsertValues = vi.fn().mockReturnValue({
    returning: mockReturning,
});
const mockInsert = vi.fn().mockReturnValue({
    values: mockInsertValues,
});

const mockUpdateReturning = vi.fn();
const mockUpdateWhere = vi.fn().mockReturnValue({
    returning: mockUpdateReturning,
});
const mockUpdateSet = vi.fn().mockReturnValue({
    where: mockUpdateWhere,
});
const mockUpdate = vi.fn().mockReturnValue({
    set: mockUpdateSet,
});

// Mock the database (only src/db/index.ts)
vi.mock('../db', () => ({
    db: {
        select: (...args: any[]) => mockSelect(...args),
        query: {
            bounties: {
                findFirst: (...args: any[]) => mockFindFirst(...args),
            },
            messages: {
                findFirst: (...args: any[]) => mockFindFirstMessage(...args),
            },
        },
        insert: (...args: any[]) => mockInsert(...args),
        update: (...args: any[]) => mockUpdate(...args),
    },
}));

describe('Socket.io WebSocket Server', () => {
    let httpServer: HTTPServer;
    let port: number;
    let ioServer: any;

    beforeAll(async () => {
        // Ensure JWT public key is set
        process.env.JWT_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----';

        // Create an HTTP server on a random free port
        httpServer = createServer();
        ioServer = initSocketServer(httpServer);

        await new Promise<void>((resolve) => {
            httpServer.listen(0, () => {
                const address = httpServer.address() as AddressInfo;
                port = address.port;
                resolve();
            });
        });
    });

    afterAll(async () => {
        // Close both io server and http server
        await new Promise<void>((resolve) => {
            ioServer.close(() => {
                httpServer.close(() => {
                    resolve();
                });
            });
        });
    });

    beforeEach(() => {
        vi.clearAllMocks();
        activeUsers.clear();
    });

    it('should reject connection when no token is provided', async () => {
        const client = Client(`http://localhost:${port}`, {
            autoConnect: false,
        });

        const connectError = new Promise<Error>((resolve) => {
            client.on('connect_error', (err) => {
                resolve(err);
            });
        });

        client.connect();
        const err = await connectError;
        expect(err.message).toContain('Authentication error: Missing token');
        client.close();
    });

    it('should reject connection when invalid token is provided', async () => {
        vi.mocked(verify).mockRejectedValue(new Error('Invalid token'));

        const client = Client(`http://localhost:${port}`, {
            autoConnect: false,
            auth: {
                token: 'invalid-token',
            },
        });

        const connectError = new Promise<Error>((resolve) => {
            client.on('connect_error', (err) => {
                resolve(err);
            });
        });

        client.connect();
        const err = await connectError;
        expect(err.message).toContain('Authentication error: Invalid or expired token');
        client.close();
    });

    it('should accept connection, authenticate and join active bounty rooms', async () => {
        const userId = 'user-123';
        const username = 'testuser';

        // Mock verification returning valid payload
        vi.mocked(verify).mockResolvedValue({
            sub: userId,
            username: username,
            exp: Math.floor(Date.now() / 1000) + 3600,
        });

        // Mock db query to return active bounties
        mockWhere.mockResolvedValue([
            { id: 'bounty-abc' },
            { id: 'bounty-xyz' },
        ]);

        const client = Client(`http://localhost:${port}`, {
            autoConnect: false,
            auth: {
                token: 'valid-token',
            },
        });

        const connected = new Promise<void>((resolve) => {
            client.on('connect', () => {
                resolve();
            });
        });

        client.connect();
        await connected;

        // Verify database query was triggered for the user
        expect(mockSelect).toHaveBeenCalled();
        expect(mockFrom).toHaveBeenCalled();
        expect(mockWhere).toHaveBeenCalled();

        // Check joined rooms on server side
        const sockets = await ioServer.fetchSockets();
        const serverSocket = sockets.find((s: any) => s.id === client.id);

        expect(serverSocket).toBeDefined();
        expect(serverSocket.data.user.id).toBe(userId);
        expect(serverSocket.data.user.username).toBe(username);

        // Fetch rooms socket is in
        const rooms = serverSocket.rooms;
        expect(rooms).toContain('bounty:bounty-abc');
        expect(rooms).toContain('bounty:bounty-xyz');

        client.close();
    });

    describe('Messaging Integration', () => {
        const bountyId = 'bounty-456';
        const creatorId = 'creator-111';
        const assigneeId = 'assignee-222';

        beforeEach(() => {
            // Setup db mocks for bounty checks
            mockFindFirst.mockResolvedValue({
                id: bountyId,
                creatorId,
                assigneeId,
                title: 'Build WebSockets',
            });

            // Mock database insert returning the saved message
            mockReturning.mockImplementation((values: any) => [
                {
                    id: 'msg-999',
                    bountyId,
                    senderId: creatorId,
                    recipientId: assigneeId,
                    content: values?.content || 'hello',
                    createdAt: new Date(),
                }
            ]);
        });

        it('should send a message, persist to database with XSS sanitization, broadcast to bounty room, and trigger push notification for offline recipient', async () => {
            // Mock jwt verification for the sender (creator)
            vi.mocked(verify).mockResolvedValue({
                sub: creatorId,
                username: 'creatorUser',
                exp: Math.floor(Date.now() / 1000) + 3600,
            });

            // Mock no active rooms to return
            mockWhere.mockResolvedValue([]);

            const creatorClient = Client(`http://localhost:${port}`, {
                autoConnect: false,
                auth: {
                    token: 'creator-token',
                },
            });

            // Connect the creator
            await new Promise<void>((resolve) => {
                creatorClient.on('connect', resolve);
                creatorClient.connect();
            });

            // Listen for message broadcasts in the room (we also need the sender to join the room)
            // By default connection joins rooms, let's join manually to be absolutely sure
            const sockets = await ioServer.fetchSockets();
            const creatorSocket = sockets.find((s: any) => s.id === creatorClient.id);
            await creatorSocket.join(`bounty:${bountyId}`);

            const receivedBroadcast = new Promise<any>((resolve) => {
                creatorClient.on('message:new', (msg) => {
                    resolve(msg);
                });
            });

            // Emit message:send with potential XSS scripts
            const xssContent = '<script>alert("XSS")</script> Perfect!';
            const ackPromise = new Promise<any>((resolve) => {
                creatorClient.emit('message:send', { bountyId, content: xssContent }, (ack: any) => {
                    resolve(ack);
                });
            });

            const ack = await ackPromise;
            expect(ack.success).toBe(true);
            expect(ack.message.id).toBe('msg-999');

            // Verify XSS sanitization occurred in database insert call
            expect(mockInsert).toHaveBeenCalled();
            expect(mockInsertValues).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt; Perfect!',
                })
            );

            // Verify broadcasting is received
            const broadcast = await receivedBroadcast;
            expect(broadcast.id).toBe('msg-999');

            // Verify push notification is triggered since recipient is offline (assigneeId is not connected)
            expect(sendPushNotification).toHaveBeenCalledWith(
                expect.objectContaining({
                    recipientId: assigneeId,
                    title: expect.stringContaining('Build WebSockets'),
                    body: expect.stringContaining('<script>'),
                })
            );

            creatorClient.close();
        });

        it('should NOT trigger push notification when the recipient is online', async () => {
            // Mock creator JWT
            vi.mocked(verify).mockResolvedValueOnce({
                sub: assigneeId,
                username: 'assigneeUser',
            }).mockResolvedValueOnce({
                sub: creatorId,
                username: 'creatorUser',
            });

            // Mock no active rooms
            mockWhere.mockResolvedValue([]);

            // Connect assignee client to mark them online
            const assigneeClient = Client(`http://localhost:${port}`, {
                autoConnect: false,
                auth: {
                    token: 'assignee-token',
                },
            });

            await new Promise<void>((resolve) => {
                assigneeClient.on('connect', resolve);
                assigneeClient.connect();
            });

            // Connect creator client
            const creatorClient = Client(`http://localhost:${port}`, {
                autoConnect: false,
                auth: {
                    token: 'creator-token',
                },
            });

            await new Promise<void>((resolve) => {
                creatorClient.on('connect', resolve);
                creatorClient.connect();
            });

            // Creator sends message
            const ackPromise = new Promise<any>((resolve) => {
                creatorClient.emit('message:send', { bountyId, content: 'Hey!' }, (ack: any) => {
                    resolve(ack);
                });
            });

            const ack = await ackPromise;
            expect(ack.success).toBe(true);

            // Since assignee was connected and active, push notification should NOT have been triggered
            expect(sendPushNotification).not.toHaveBeenCalled();

            assigneeClient.close();
            creatorClient.close();
        });

        it('should fail to send a message if content exceeds 5000 characters', async () => {
            vi.mocked(verify).mockResolvedValue({
                sub: creatorId,
                username: 'creatorUser',
            });
            mockWhere.mockResolvedValue([]);

            const creatorClient = Client(`http://localhost:${port}`, {
                autoConnect: false,
                auth: { token: 'creator-token' },
            });

            await new Promise<void>((resolve) => {
                creatorClient.on('connect', resolve);
                creatorClient.connect();
            });

            const longContent = 'A'.repeat(5001);
            const ackPromise = new Promise<any>((resolve) => {
                creatorClient.emit('message:send', { bountyId, content: longContent }, (ack: any) => {
                    resolve(ack);
                });
            });

            const ack = await ackPromise;
            expect(ack.success).toBe(false);
            expect(ack.error).toContain('Message content exceeds the maximum allowed length');

            creatorClient.close();
        });

        it('should fail to send a message if bounty is completed or cancelled', async () => {
            vi.mocked(verify).mockResolvedValue({
                sub: creatorId,
                username: 'creatorUser',
            });
            mockWhere.mockResolvedValue([]);

            // Mock completed bounty
            mockFindFirst.mockResolvedValueOnce({
                id: bountyId,
                creatorId,
                assigneeId,
                status: 'completed',
            });

            const creatorClient = Client(`http://localhost:${port}`, {
                autoConnect: false,
                auth: { token: 'creator-token' },
            });

            await new Promise<void>((resolve) => {
                creatorClient.on('connect', resolve);
                creatorClient.connect();
            });

            const ackPromise = new Promise<any>((resolve) => {
                creatorClient.emit('message:send', { bountyId, content: 'Hey' }, (ack: any) => {
                    resolve(ack);
                });
            });

            const ack = await ackPromise;
            expect(ack.success).toBe(false);
            expect(ack.error).toContain('Cannot send messages for completed or cancelled bounties');

            creatorClient.close();
        });

        describe('Read Receipts (message:read)', () => {
            it('should mark a specific message as read and broadcast event', async () => {
                const messageId = 'msg-123';
                // Mock current user as recipient
                vi.mocked(verify).mockResolvedValue({
                    sub: creatorId,
                    username: 'creatorUser',
                });
                mockWhere.mockResolvedValue([]);

                // Mock finding the message where user is recipient
                mockFindFirstMessage.mockResolvedValue({
                    id: messageId,
                    bountyId,
                    senderId: assigneeId,
                    recipientId: creatorId,
                    content: 'Hello!',
                    readAt: null,
                });

                // Mock db.update returning the updated message
                const updatedMsg = {
                    id: messageId,
                    bountyId,
                    senderId: assigneeId,
                    recipientId: creatorId,
                    content: 'Hello!',
                    readAt: new Date(),
                };
                mockUpdateReturning.mockResolvedValue([updatedMsg]);

                const client = Client(`http://localhost:${port}`, {
                    autoConnect: false,
                    auth: { token: 'creator-token' },
                });

                await new Promise<void>((resolve) => {
                    client.on('connect', resolve);
                    client.connect();
                });

                // Join the room manually
                const sockets = await ioServer.fetchSockets();
                const serverSocket = sockets.find((s: any) => s.id === client.id);
                await serverSocket.join(`bounty:${bountyId}`);

                // Listen for message:read broadcast
                const receivedBroadcast = new Promise<any>((resolve) => {
                    client.on('message:read', resolve);
                });

                const ackPromise = new Promise<any>((resolve) => {
                    client.emit('message:read', { messageId }, (ack: any) => {
                        resolve(ack);
                    });
                });

                const ack = await ackPromise;
                expect(ack.success).toBe(true);
                expect(ack.messages[0].id).toBe(messageId);
                expect(ack.messages[0].readAt).toBeDefined();

                const broadcast = await receivedBroadcast;
                expect(broadcast.bountyId).toBe(bountyId);
                expect(broadcast.messageIds).toContain(messageId);
                expect(broadcast.readerId).toBe(creatorId);

                client.close();
            });

            it('should mark all unread messages in a bounty room as read and broadcast event', async () => {
                // Mock current user as recipient (creatorId)
                vi.mocked(verify).mockResolvedValue({
                    sub: creatorId,
                    username: 'creatorUser',
                });
                mockWhere.mockResolvedValue([]);

                // Mock finding the bounty
                mockFindFirst.mockResolvedValue({
                    id: bountyId,
                    creatorId,
                    assigneeId,
                });

                // Mock db.update returning all updated messages
                const updatedMsg1 = {
                    id: 'msg-1',
                    bountyId,
                    senderId: assigneeId,
                    recipientId: creatorId,
                    content: 'First message',
                    readAt: new Date(),
                };
                const updatedMsg2 = {
                    id: 'msg-2',
                    bountyId,
                    senderId: assigneeId,
                    recipientId: creatorId,
                    content: 'Second message',
                    readAt: new Date(),
                };
                mockUpdateReturning.mockResolvedValue([updatedMsg1, updatedMsg2]);

                const client = Client(`http://localhost:${port}`, {
                    autoConnect: false,
                    auth: { token: 'creator-token' },
                });

                await new Promise<void>((resolve) => {
                    client.on('connect', resolve);
                    client.connect();
                });

                // Join the room manually
                const sockets = await ioServer.fetchSockets();
                const serverSocket = sockets.find((s: any) => s.id === client.id);
                await serverSocket.join(`bounty:${bountyId}`);

                // Listen for message:read broadcast
                const receivedBroadcast = new Promise<any>((resolve) => {
                    client.on('message:read', resolve);
                });

                const ackPromise = new Promise<any>((resolve) => {
                    client.emit('message:read', { bountyId }, (ack: any) => {
                        resolve(ack);
                    });
                });

                const ack = await ackPromise;
                expect(ack.success).toBe(true);
                expect(ack.messages.length).toBe(2);
                expect(ack.messages[0].id).toBe('msg-1');
                expect(ack.messages[1].id).toBe('msg-2');

                const broadcast = await receivedBroadcast;
                expect(broadcast.bountyId).toBe(bountyId);
                expect(broadcast.messageIds).toContain('msg-1');
                expect(broadcast.messageIds).toContain('msg-2');
                expect(broadcast.readerId).toBe(creatorId);

                client.close();
            });

            it('should fail if user is not the recipient of the specific message', async () => {
                const messageId = 'msg-123';
                // User is creatorId, but message recipient is assigneeId
                vi.mocked(verify).mockResolvedValue({
                    sub: creatorId,
                    username: 'creatorUser',
                });
                mockWhere.mockResolvedValue([]);

                mockFindFirstMessage.mockResolvedValue({
                    id: messageId,
                    bountyId,
                    senderId: creatorId,
                    recipientId: assigneeId, // recipient is assignee, not creator
                    content: 'Hello!',
                    readAt: null,
                });

                const client = Client(`http://localhost:${port}`, {
                    autoConnect: false,
                    auth: { token: 'creator-token' },
                });

                await new Promise<void>((resolve) => {
                    client.on('connect', resolve);
                    client.connect();
                });

                const ackPromise = new Promise<any>((resolve) => {
                    client.emit('message:read', { messageId }, (ack: any) => {
                        resolve(ack);
                    });
                });

                const ack = await ackPromise;
                expect(ack.success).toBe(false);
                expect(ack.error).toContain('Unauthorized');

                client.close();
            });

            it('should fail if user is not a participant of the bounty when marking by bountyId', async () => {
                // User is creatorId
                vi.mocked(verify).mockResolvedValue({
                    sub: creatorId,
                    username: 'creatorUser',
                });
                mockWhere.mockResolvedValue([]);

                // Bounty belongs to different users
                mockFindFirst.mockResolvedValue({
                    id: bountyId,
                    creatorId: 'other-creator',
                    assigneeId: 'other-assignee',
                });

                const client = Client(`http://localhost:${port}`, {
                    autoConnect: false,
                    auth: { token: 'creator-token' },
                });

                await new Promise<void>((resolve) => {
                    client.on('connect', resolve);
                    client.connect();
                });

                const ackPromise = new Promise<any>((resolve) => {
                    client.emit('message:read', { bountyId }, (ack: any) => {
                        resolve(ack);
                    });
                });

                const ack = await ackPromise;
                expect(ack.success).toBe(false);
                expect(ack.error).toContain('Unauthorized');

                client.close();
            });

            it('should fail if neither messageId nor bountyId is provided', async () => {
                vi.mocked(verify).mockResolvedValue({
                    sub: creatorId,
                    username: 'creatorUser',
                });
                mockWhere.mockResolvedValue([]);

                const client = Client(`http://localhost:${port}`, {
                    autoConnect: false,
                    auth: { token: 'creator-token' },
                });

                await new Promise<void>((resolve) => {
                    client.on('connect', resolve);
                    client.connect();
                });

                const ackPromise = new Promise<any>((resolve) => {
                    client.emit('message:read', {}, (ack: any) => {
                        resolve(ack);
                    });
                });

                const ack = await ackPromise;
                expect(ack.success).toBe(false);
                expect(ack.error).toContain('Invalid parameters');

                client.close();
            });
        });
    });
});
