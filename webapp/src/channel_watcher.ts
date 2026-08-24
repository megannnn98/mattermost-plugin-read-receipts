import {loadChannelReceipts} from './actions';

export const MAX_QUERY_IDS = 200;

export function isDirectChannel(state: any, channelId: string): boolean | null {
    const channel = state?.entities?.channels?.channels?.[channelId];
    if (!channel) {
        return null;
    }
    return channel.type === 'D';
}

/**
 * Own, non-deleted posts of the channel, newest first, capped at `limit`.
 * Only own posts need receipts: the indicator is rendered for the sender only.
 */
export function collectOwnPostIds(state: any, channelId: string, limit: number = MAX_QUERY_IDS): string[] {
    const currentUserId = state?.entities?.users?.currentUserId;
    const posts = state?.entities?.posts?.posts;
    const blocks = state?.entities?.posts?.postsInChannel?.[channelId];

    if (!currentUserId || !posts || !Array.isArray(blocks)) {
        return [];
    }

    const postIds: string[] = [];
    for (const block of blocks) {
        for (const postId of block?.order ?? []) {
            const post = posts[postId];
            if (!post || post.user_id !== currentUserId || post.delete_at) {
                continue;
            }
            postIds.push(postId);
            if (postIds.length >= limit) {
                return postIds;
            }
        }
    }
    return postIds;
}

export interface ChannelWatcher {
    stop: () => void;
    refresh: () => void;
    check: () => void;
}

/**
 * Loads persisted receipts once per opened DM channel. Event-driven: reacts to
 * Redux store changes (channel switch, first batch of posts arriving), no polling.
 */
export function startChannelWatcher(store: any): ChannelWatcher {
    let handledChannelId: string | null = null;
    let inFlight = false;

    const check = () => {
        const state = store.getState();
        const channelId = state?.entities?.channels?.currentChannelId;

        if (!channelId || channelId === handledChannelId || inFlight) {
            return;
        }

        const isDM = isDirectChannel(state, channelId);
        if (isDM === null) {
            // Channel entity not loaded yet — retry on a later store update.
            return;
        }
        if (!isDM) {
            handledChannelId = channelId;
            return;
        }

        const postIds = collectOwnPostIds(state, channelId);
        if (postIds.length === 0) {
            // Posts not loaded yet (or nothing of ours here) — retry later.
            return;
        }

        inFlight = true;
        const done = () => {
            inFlight = false;
            handledChannelId = channelId;
        };
        loadChannelReceipts(store, channelId, postIds).then(done, done);
    };

    const unsubscribe = store.subscribe(check);
    check();

    return {
        stop: () => unsubscribe(),
        refresh: () => {
            handledChannelId = null;
            check();
        },
        check,
    };
}
