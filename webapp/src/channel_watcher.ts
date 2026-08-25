import {loadChannelReceipts} from './actions';
import {GlobalState, PluginStore} from './types';

export const MAX_QUERY_IDS = 200;
export const RETRY_BASE_MS = 5000;
export const RETRY_MAX_MS = 60000;

export function isDirectChannel(state: GlobalState, channelId: string): boolean | null {
    const channel = state?.entities?.channels?.channels?.[channelId];
    if (!channel) {
        return null;
    }
    return channel.type === 'D';
}

/**
 * Own, non-deleted posts of the channel, newest first, capped at `limit`.
 * Only own posts need receipts: the indicator is rendered for the sender only.
 *
 * The position of a block inside `postsInChannel` is deliberately not trusted:
 * `mergePostBlocks` sorts blocks newest-first but bails out with the original
 * array when no merge happened, so a freshly pushed block can sit anywhere.
 * That is why the webapp's own selectors locate blocks by the `recent`/`oldest`
 * flags instead of by index. Sorting the collected posts by `create_at` makes
 * the result independent of both the block order and the order inside a block.
 */
export function collectOwnPostIds(state: GlobalState, channelId: string, limit: number = MAX_QUERY_IDS): string[] {
    const currentUserId = state?.entities?.users?.currentUserId;
    const posts = state?.entities?.posts?.posts;
    const blocks = state?.entities?.posts?.postsInChannel?.[channelId];

    if (!currentUserId || !posts || !Array.isArray(blocks)) {
        return [];
    }

    const own = new Map<string, number>();
    for (const block of blocks) {
        for (const postId of block?.order ?? []) {
            const post = posts[postId];
            if (!post || post.user_id !== currentUserId || post.delete_at) {
                continue;
            }
            own.set(postId, post.create_at);
        }
    }

    return [...own.entries()].
        sort((a, b) => b[1] - a[1]).
        slice(0, limit).
        map(([postId]) => postId);
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
export function startChannelWatcher(store: PluginStore): ChannelWatcher {
    let handledChannelId: string | null = null;
    let inFlightChannelId: string | null = null;
    let refreshRequested = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryChannelId: string | null = null;
    let failures = 0;
    let stopped = false;

    const clearRetry = () => {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        retryChannelId = null;
    };

    const check = () => {
        if (stopped) {
            return;
        }
        const state = store.getState();
        const channelId = state?.entities?.channels?.currentChannelId;

        if (retryTimer && retryChannelId !== channelId) {
            clearRetry();
            failures = 0;
        }

        // No channel yet, already handled, or a query is mid-flight. In the
        // in-flight case `done()` re-runs check unconditionally, so a channel
        // switch that happened while the query was pending is picked up then.
        if (!channelId || channelId === handledChannelId || inFlightChannelId !== null || retryTimer !== null) {
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

        inFlightChannelId = channelId;
        const done = (ok: boolean) => {
            inFlightChannelId = null;
            if (stopped) {
                return;
            }
            if (ok && !refreshRequested) {
                handledChannelId = channelId;
            }
            if (ok) {
                failures = 0;
                clearRetry();
            } else {
                failures += 1;
                retryChannelId = channelId;
                const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    retryChannelId = null;
                    check();
                }, delay);
            }
            refreshRequested = false;
            // Unconditional re-check: if the user switched to another channel
            // while this query was pending, load it now. Without this the
            // switch would be lost and channel B might never load.
            check();
        };
        // The second handler matters: loadChannelReceipts swallows request errors
        // today, but if it ever rejects, dropping the rejection would leave
        // inFlightChannelId set forever and the watcher permanently dead.
        loadChannelReceipts(store, channelId, postIds).then(done, () => done(false));
    };

    const unsubscribe = store.subscribe(check);
    check();

    return {
        stop: () => {
            stopped = true;
            clearRetry();
            unsubscribe();
        },
        refresh: () => {
            // If a query is in flight, mark that the current channel must be
            // reloaded once it finishes (its done() re-checks unconditionally).
            // If idle, resetting handledChannelId below is enough to trigger a
            // fresh load.
            if (inFlightChannelId !== null) {
                refreshRequested = true;
            }
            // A reconnect is exactly the event a backed-off channel was waiting
            // for: drop the pending backoff instead of sitting it out.
            clearRetry();
            failures = 0;
            handledChannelId = null;
            check();
        },
        check,
    };
}
