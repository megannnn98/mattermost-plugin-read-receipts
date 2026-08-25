import {PLUGIN_ID, fetchChannelReceipts, reportRead} from './client';
import {ACTION_TYPES} from './reducer';
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
): Promise<void> {
    if (postIds.length === 0) {
        return;
    }

    try {
        const response = await fetchChannelReceipts(channelId, postIds);
        store.dispatch({
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId,
                watermark: response.watermark,
                receipts: response.receipts,
            },
        });
    } catch (error) {
        console.error(`[${PLUGIN_ID}] Failed to load receipts:`, error);
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
        console.error(`[${PLUGIN_ID}] Failed to send read receipt:`, error);
        return false;
    }
}
