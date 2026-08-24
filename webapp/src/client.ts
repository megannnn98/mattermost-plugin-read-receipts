export const PLUGIN_ID = 'com.integrasources.read-receipts';
const BASE_URL = `/plugins/${PLUGIN_ID}/api/v1`;

function getCSRFToken(): string | null {
    const match = document.cookie.match(/MMCSRF=([^;]+)/);
    return match ? match[1] : null;
}

async function request<T>(endpoint: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    };

    const csrf = getCSRFToken();
    if (csrf) {
        headers['X-CSRF-Token'] = csrf;
    }

    const response = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

export interface ReadResponse {
    post_id: string;
    channel_id: string;
    create_at: number;
    read_at: number;
}

export interface QueryResponse {
    watermark: {
        post_id: string;
        create_at: number;
        read_at: number;
    } | null;
    receipts: Record<string, number>;
    debug: boolean;
}

export async function reportRead(postId: string): Promise<ReadResponse> {
    return request<ReadResponse>('/read', {post_id: postId});
}

export async function fetchChannelReceipts(
    channelId: string,
    postIds: string[]
): Promise<QueryResponse> {
    return request<QueryResponse>('/receipts/query', {
        channel_id: channelId,
        post_ids: postIds,
    });
}
