import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createApp } from '../app';
import { verify } from 'hono/jwt';

// Mock hono/jwt verify
vi.mock('hono/jwt', () => ({
    verify: vi.fn(),
}));

const { mockSelect, mockFrom, mockWhere, mockFindFirstUser, mockFindFirstMessage } = vi.hoisted(() => ({
    mockSelect: vi.fn(),
    mockFrom: vi.fn(),
    mockWhere: vi.fn(),
    mockFindFirstUser: vi.fn(),
    mockFindFirstMessage: vi.fn(),
}));

// Mock the database
vi.mock('../db', () => ({
    db: {
        select: (...args: any[]) => mockSelect(...args),
        from: (...args: any[]) => mockFrom(...args),
        where: (...args: any[]) => mockWhere(...args),
        query: {
            users: {
                findFirst: (...args: any[]) => mockFindFirstUser(...args),
            },
            messages: {
                findFirst: (...args: any[]) => mockFindFirstMessage(...args),
            },
        },
    },
}));

describe('GET /api/conversations', () => {
    let app: ReturnType<typeof createApp>;

    beforeAll(() => {
        app = createApp();

        // Ensure the public key is set
        process.env.JWT_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----';
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    it('should return 401 Unauthorized if no JWT token is provided', async () => {
        const res = await app.request('/api/conversations');
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toBe('Missing or invalid Authorization header');
    });

    it('should return a list of active conversations with last message and unread count', async () => {
        const userId = 'user-123';
        const otherUserId = 'user-456';

        // Bypass auth
        vi.mocked(verify).mockResolvedValue({
            sub: userId,
            username: 'testuser',
            exp: Math.floor(Date.now() / 1000) + 3600
        });

        // 1. Mock db.select for active bounties list
        const mockActiveBounties = [
            {
                id: 'bounty-1',
                title: 'Bounty One',
                repoOwner: 'owner',
                repoName: 'repo',
                status: 'assigned',
                creatorId: userId,
                assigneeId: otherUserId,
            }
        ];

        // Setup chained mocks: select -> from -> where
        mockSelect.mockReturnValueOnce({
            from: mockFrom.mockReturnValueOnce({
                where: mockWhere.mockResolvedValueOnce(mockActiveBounties) // For active bounties
            })
        });

        // 2. Mock db.query.users.findFirst for other participant
        mockFindFirstUser.mockResolvedValueOnce({
            id: otherUserId,
            username: 'otherdeveloper',
            avatarUrl: 'https://picsum.photos/100',
        });

        // 3. Mock db.query.messages.findFirst for last message
        const lastMessageDate = new Date();
        mockFindFirstMessage.mockResolvedValueOnce({
            id: 'msg-999',
            content: 'Hello developer!',
            senderId: otherUserId,
            createdAt: lastMessageDate,
            readAt: null,
        });

        // 4. Mock count selection for unread messages (called sequentially)
        mockSelect.mockReturnValueOnce({
            from: mockFrom.mockReturnValueOnce({
                where: mockWhere.mockResolvedValueOnce([{ value: 2 }]) // For unread count
            })
        });

        const res = await app.request('/api/conversations', {
            headers: {
                'Authorization': 'Bearer valid.token'
            }
        });

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.length).toBe(1);
        expect(body[0].bountyId).toBe('bounty-1');
        expect(body[0].title).toBe('Bounty One');
        expect(body[0].otherParticipant.username).toBe('otherdeveloper');
        expect(body[0].lastMessage.content).toBe('Hello developer!');
        expect(body[0].unreadCount).toBe(2);
    });

    it('should return empty list if no active conversations exist', async () => {
        vi.mocked(verify).mockResolvedValue({
            sub: 'user-123',
            username: 'testuser',
            exp: Math.floor(Date.now() / 1000) + 3600
        });

        mockSelect.mockReturnValueOnce({
            from: mockFrom.mockReturnValueOnce({
                where: mockWhere.mockResolvedValueOnce([]) // Empty list
            })
        });

        const res = await app.request('/api/conversations', {
            headers: {
                'Authorization': 'Bearer valid.token'
            }
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual([]);
    });
});
