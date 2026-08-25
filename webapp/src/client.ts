export const PLUGIN_ID = 'com.integrasources.read-receipts';
const BASE_URL = `/plugins/${PLUGIN_ID}/api/v1`;

function getCSRFToken(): string | null {
    const match = document.cookie.match(/MMCSRF=([^;]+)/);
    return match ? match[1] : null;
}

export class RequestError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
    }
}

async function request<T>(url: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    };

    const csrf = getCSRFToken();
    if (csrf) {
        headers['X-CSRF-Token'] = csrf;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new RequestError(response.status, `Request failed: ${response.status} ${response.statusText}`);
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
    watermarks: Array<{
        reader_id: string;
        post_id: string;
        create_at: number;
        read_at: number;
    }>;
    receipts: Record<string, Record<string, number>>;
    truncated: boolean;
}

export interface PostReadersResponse {
    readers: Array<{user_id: string; read_at: number; exact: boolean}>;
    truncated: boolean;
}

export async function reportRead(postId: string): Promise<ReadResponse> {
    return request<ReadResponse>(`${BASE_URL}/read`, {post_id: postId});
}

export async function fetchPostReaders(postId: string): Promise<PostReadersResponse> {
    return request<PostReadersResponse>(`${BASE_URL}/receipts/post`, {post_id: postId});
}

export async function fetchUsersByIds(userIds: string[]): Promise<Array<{id: string; username: string; first_name?: string; last_name?: string}>> {
    return request('/api/v4/users/ids', userIds);
}

export async function fetchChannelReceipts(
    channelId: string,
    postIds: string[]
): Promise<QueryResponse> {
    return request<QueryResponse>(`${BASE_URL}/receipts/query`, {
        channel_id: channelId,
        post_ids: postIds,
    });
}
