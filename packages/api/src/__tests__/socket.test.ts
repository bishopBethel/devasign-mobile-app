import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, Server as HTTPServer } from 'http';
import { io as Client } from 'socket.io-client';
import { verify } from 'hono/jwt';
import { initSocketServer } from '../socket';
import type { AddressInfo } from 'net';

// Mock hono/jwt verify
vi.mock('hono/jwt', () => ({
    verify: vi.fn(),
}));

const mockWhere = vi.fn();
const mockFrom = vi.fn().mockReturnValue({
    where: mockWhere,
});
const mockSelect = vi.fn().mockReturnValue({
    from: mockFrom,
});

// Mock the database (only src/db/index.ts)
vi.mock('../db', () => ({
    db: {
        select: (...args: any[]) => mockSelect(...args),
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
});
