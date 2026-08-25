export const PLUGIN_ID = 'com.integrasources.read-receipts';
const BASE_URL = `/plugins/${PLUGIN_ID}/api/v1`;

// A request that never settles would leave the channel watcher believing a query
// is still in flight and stop it from ever loading another channel, so every call
// is given a deadline. The abort surfaces as an ordinary failure and therefore
// goes down the existing retry/backoff path.
export const REQUEST_TIMEOUT_MS = 10000;

export class RequestError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
    }
}

function getCSRFToken(): string | null {
    const match = document.cookie.match(/MMCSRF=([^;]+)/);
    return match ? match[1] : null;
}

async function request<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    };

    const csrf = getCSRFToken();
    if (csrf) {
        headers['X-CSRF-Token'] = csrf;
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

    try {
        const response = await fetch(url, {
            method,
            headers,
            credentials: 'same-origin',
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller?.signal,
        });

        if (!response.ok) {
            throw new RequestError(response.status, `Request failed: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

export interface ReadResponse {
    post_id: string;
    channel_id: string;
    create_at: number;
    read_at: number;
}

export interface QueryResponse {
    posts: Record<string, {count: number; truncated: boolean; read_at?: number}>;
    truncated: boolean;
}

export interface PostReadersResponse {
    readers: Array<{user_id: string; read_at: number; exact: boolean}>;
    truncated: boolean;
    next_offset?: number;
}

export interface ConfigResponse {
    enabled_channel_types: string;
}

export async function reportRead(postId: string): Promise<ReadResponse> {
    return request<ReadResponse>(`${BASE_URL}/read`, {post_id: postId});
}

export async function fetchPostReaders(postId: string, offset = 0): Promise<PostReadersResponse> {
    return request<PostReadersResponse>(`${BASE_URL}/receipts/post`, {post_id: postId, offset});
}

export async function fetchPluginConfig(): Promise<ConfigResponse> {
    return request<ConfigResponse>(`${BASE_URL}/config`, undefined, 'GET');
}

export async function fetchUsersByIds(userIds: string[]): Promise<Array<{id: string; username: string; first_name?: string; last_name?: string}>> {
    return request('/api/v4/users/ids', userIds);
}

export async function fetchChannelReceipts(
    channelId: string,
    postIds: string[],
): Promise<QueryResponse> {
    return request<QueryResponse>(`${BASE_URL}/receipts/query`, {
        channel_id: channelId,
        post_ids: postIds,
    });
}
