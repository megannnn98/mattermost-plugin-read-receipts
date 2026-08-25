import {PLUGIN_ID, fetchChannelReceipts, fetchPluginConfig, fetchPostReaders, fetchUsersByIds, reportRead, RequestError} from './client';
import {ACTION_TYPES} from './reducer';
import {selectReadersEpoch} from './selectors';
import {PluginStore} from './types';

class ReadDeduplicator {
    private sentCreateAt: Record<string, number> = {};
    private sentPostIds: Record<string, Set<string>> = {};

    shouldSend(channelId: string, postId: string, createAt: number): boolean {
        const sent = this.sentCreateAt[channelId];
        if (sent && createAt <= sent) {
            return false;
        }
        const channelPosts = this.sentPostIds[channelId];
        if (channelPosts && channelPosts.has(postId)) {
            return false;
        }
        return true;
    }

    markSent(channelId: string, postId: string, createAt: number): void {
        const sent = this.sentCreateAt[channelId];
        if (!sent || createAt > sent) {
            this.sentCreateAt[channelId] = createAt;
        }
        if (!this.sentPostIds[channelId]) {
            this.sentPostIds[channelId] = new Set();
        }
        this.sentPostIds[channelId].add(postId);
    }

    resetChannel(channelId: string): void {
        delete this.sentCreateAt[channelId];
        delete this.sentPostIds[channelId];
    }

    resetAll(): void {
        this.sentCreateAt = {};
        this.sentPostIds = {};
    }
}

let globalDeduplicator: ReadDeduplicator | null = null;

export function getDeduplicator(): ReadDeduplicator {
    if (!globalDeduplicator) {
        globalDeduplicator = new ReadDeduplicator();
    }
    return globalDeduplicator;
}

export function resetDeduplicator(): void {
    if (globalDeduplicator) {
        globalDeduplicator.resetAll();
        globalDeduplicator = null;
    }
}

export async function loadChannelReceipts(
    store: PluginStore,
    channelId: string,
    postIds: string[],
): Promise<boolean> {
    if (postIds.length === 0) {
        return false;
    }

    try {
        const response = await fetchChannelReceipts(channelId, postIds);
        store.dispatch({
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId,
                posts: response.posts,
                truncated: response.truncated,
            },
        });
        return true;
    } catch (error) {
        if ((error as RequestError).status === 403) {
            return true;
        }
        console.error(`[${PLUGIN_ID}] Failed to load receipts:`, error);
        return false;
    }
}

export async function sendReadReceipt(
    channelId: string,
    postId: string,
    createAt: number,
): Promise<boolean> {
    const dedup = getDeduplicator();
    if (!dedup.shouldSend(channelId, postId, createAt)) {
        return true;
    }

    try {
        await reportRead(postId);
        dedup.markSent(channelId, postId, createAt);
        return true;
    } catch (error) {
        if ((error as RequestError).status === 403) {
            dedup.markSent(channelId, postId, createAt);
            return true;
        }
        console.error(`[${PLUGIN_ID}] Failed to send read receipt:`, error);
        return false;
    }
}

/**
 * Loads one page of the reader list of a post, plus the profiles needed to name
 * the people in it. `offset` continues a truncated list rather than restarting it.
 *
 * The reader-list epoch is captured *before* the request goes out and carried on
 * the dispatch. If a websocket receipt invalidates this post while the request is
 * in flight, the reducer bumps the epoch and drops this now-stale page, so it can
 * never overwrite a fresher list.
 */
export async function loadPostReaders(store: PluginStore, postId: string, offset = 0): Promise<void> {
    const epoch = selectReadersEpoch(store.getState(), postId);
    const response = await fetchPostReaders(postId, offset);
    store.dispatch({
        type: ACTION_TYPES.POST_READERS,
        data: {
            postId,
            readers: response.readers,
            truncated: response.truncated,
            nextOffset: response.next_offset ?? 0,
            append: offset > 0,
            epoch,
        },
    });

    const state = store.getState();
    const pluginBranch = state[`plugins-${PLUGIN_ID}`] as {profiles?: Record<string, unknown>} | undefined;
    const known = {
        ...(state.entities?.users?.profiles ?? {}),
        ...(pluginBranch?.profiles ?? {}),
    };
    const missing = response.readers.map((reader) => reader.user_id).filter((userId) => !known[userId]);
    if (missing.length === 0) {
        return;
    }
    const profiles = await fetchUsersByIds(missing);
    store.dispatch({
        type: ACTION_TYPES.PROFILES,
        data: {profiles: Object.fromEntries(profiles.map((profile) => [profile.id, profile]))},
    });
}

/**
 * Loads the channel types the server collects receipts for. Until this lands the
 * plugin stays inert, so a type an administrator disabled never gets an indicator
 * or a read report — rather than being discovered from a 403 after the fact.
 */
export async function loadPluginConfig(store: PluginStore): Promise<boolean> {
    try {
        const config = await fetchPluginConfig();
        store.dispatch({type: ACTION_TYPES.CONFIG, data: {config}});
        return true;
    } catch (error) {
        console.error(`[${PLUGIN_ID}] Failed to load plugin configuration:`, error);
        return false;
    }
}
