export interface PushNotificationPayload {
    recipientId: string;
    title: string;
    body: string;
    data?: Record<string, any>;
}

/**
 * Sends a push notification to a specific recipient.
 * Currently simulates/mocks push service integration by logging details.
 */
export async function sendPushNotification(payload: PushNotificationPayload): Promise<void> {
    console.log(`[Push Notification] Sending push to user ${payload.recipientId}:`);
    console.log(`  Title: ${payload.title}`);
    console.log(`  Body: ${payload.body}`);
    if (payload.data) {
        console.log(`  Data:`, JSON.stringify(payload.data));
    }
    
    // Simulate slight asynchronous latency matching standard network push requests
    await new Promise((resolve) => setTimeout(resolve, 50));
}
