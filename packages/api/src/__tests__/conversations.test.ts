import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createApp } from '../app';
import { verify } from 'hono/jwt';

// Mock hono/jwt verify
vi.mock('hono/jwt', () => ({
    verify: vi.fn(),
}));

const { mockSelect, mockFrom, mockWhere, mockFindFirstUser, mockFindFirstMessage, mockFindFirstBounty } = vi.hoisted(() => ({
    mockSelect: vi.fn(),
    mockFrom: vi.fn(),
    mockWhere: vi.fn(),
    mockFindFirstUser: vi.fn(),
    mockFindFirstMessage: vi.fn(),
    mockFindFirstBounty: vi.fn(),
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
            bounties: {
                findFirst: (...args: any[]) => mockFindFirstBounty(...args),
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

describe('GET /api/conversations/:bountyId/messages', () => {
    let app: ReturnType<typeof createApp>;

    beforeAll(() => {
        app = createApp();
        process.env.JWT_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----';
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    it('should return 401 Unauthorized if no JWT token is provided', async () => {
        const res = await app.request('/api/conversations/123e4567-e89b-12d3-a456-426614174000/messages');
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toBe('Missing or invalid Authorization header');
    });

    it('should return 400 Bad Request if bountyId is not a valid UUID', async () => {
        vi.mocked(verify).mockResolvedValue({
            sub: 'user-123',
            username: 'testuser',
            exp: Math.floor(Date.now() / 1000) + 3600
        });

        const res = await app.request('/api/conversations/invalid-uuid/messages', {
            headers: {
                'Authorization': 'Bearer valid.token'
            }
        });

        expect(res.status).toBe(400);
    });

    it('should return 404 Bounty Not Found if bounty does not exist', async () => {
        vi.mocked(verify).mockResolvedValue({
            sub: 'user-123',
            username: 'testuser',
            exp: Math.floor(Date.now() / 1000) + 3600
        });

        mockFindFirstBounty.mockResolvedValueOnce(null);

        const res = await app.request('/api/conversations/123e4567-e89b-12d3-a456-426614174000/messages', {
            headers: {
                'Authorization': 'Bearer valid.token'
            }
        });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toBe('Bounty not found');
    });

    it('should return 403 Forbidden if user is not creator or assignee of the bounty', async () => {
        vi.mocked(verify).mockResolvedValue({
            sub: 'user-123',
            username: 'testuser',
            exp: Math.floor(Date.now() / 1000) + 3600
        });

        mockFindFirstBounty.mockResolvedValueOnce({
            id: '123e4567-e89b-12d3-a456-426614174000',
            creatorId: 'different-creator',
            assigneeId: 'different-assignee',
        });

        const res = await app.request('/api/conversations/123e4567-e89b-12d3-a456-426614174000/messages', {
            headers: {
                'Authorization': 'Bearer valid.token'
            }
        });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toBe('Forbidden. You are not an active participant of this bounty.');
    });

    it('should successfully return paginated messages if user is creator', async () => {
        const userId = 'user-123';
        const bountyId = '123e4567-e89b-12d3-a456-426614174000';

        vi.mocked(verify).mockResolvedValue({
            sub: userId,
            username: 'testuser',
            exp: Math.floor(Date.now() / 1000) + 3600
        });

        mockFindFirstBounty.mockResolvedValueOnce({
            id: bountyId,
            creatorId: userId,
            assigneeId: 'assignee-123',
        });

        const mockMessages = [
            { id: 'msg-1', bountyId, senderId: userId, recipientId: 'assignee-123', content: 'Hello developer!', createdAt: new Date() },
            { id: 'msg-2', bountyId, senderId: 'assignee-123', recipientId: userId, content: 'Hi creator!', createdAt: new Date() }
        ];

        // Mock chained query calls for paginated messages
        const mockLimit = vi.fn().mockResolvedValue(mockMessages);
        const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        mockSelect.mockReturnValueOnce({ from: mockFrom });

        const res = await app.request(`/api/conversations/${bountyId}/messages?limit=10`, {
            headers: {
                'Authorization': 'Bearer valid.token'
            }
        });

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.data).toHaveLength(2);
        expect(body.data[0].id).toBe('msg-1');
        expect(body.meta.has_more).toBe(false);
        expect(body.meta.next_cursor).toBeNull();
        expect(body.meta.limit).toBe(10);
    });
});
