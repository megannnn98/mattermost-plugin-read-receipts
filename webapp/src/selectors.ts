import {GlobalState, PluginState, Watermark} from './types';
import {PLUGIN_ID} from './client';

const emptyPluginState: PluginState = {
    watermarks: {},
    receipts: {},
    readers: {},
    profiles: {},
};

export function selectPluginState(state: GlobalState): PluginState {
    return (state[`plugins-${PLUGIN_ID}`] as PluginState | undefined) ?? emptyPluginState;
}

export function selectChannelWatermark(state: GlobalState, channelId: string, readerId: string): Watermark | null {
    const pluginState = selectPluginState(state);
    return pluginState.watermarks[channelId]?.[readerId] ?? null;
}

export function selectPostReceipt(state: GlobalState, postId: string, readerId: string): number | null {
    const pluginState = selectPluginState(state);
    return pluginState.receipts[postId]?.[readerId] ?? null;
}

export function selectPostReadCount(state: GlobalState, postId: string, postCreateAt: number, channelId: string, authorId?: string): number {
    const pluginState = selectPluginState(state);
    const currentUserId = state.entities?.users?.currentUserId;
    const watermarks = pluginState.watermarks[channelId];
    const receipts = pluginState.receipts[postId];
    if (!watermarks && !receipts) {
        return 0;
    }
    const readerIds = new Set([...Object.keys(watermarks ?? {}), ...Object.keys(receipts ?? {})]);
    return [...readerIds].filter((readerId) => readerId !== currentUserId && readerId !== authorId && (receipts?.[readerId] !== undefined || (watermarks?.[readerId]?.create_at ?? -1) >= postCreateAt)).length;
}

// A DM has exactly one other reader. Group callers must use the count selector
// instead; picking an arbitrary object key there would be misleading.
export function selectSingleReaderReadAt(state: GlobalState, postId: string, postCreateAt: number, channelId: string): number | null {
    const pluginState = selectPluginState(state);
    const readerId = Object.keys(pluginState.watermarks[channelId] ?? {}).find((id) => id !== state.entities?.users?.currentUserId) ?? Object.keys(pluginState.receipts[postId] ?? {})[0];
    if (!readerId) {
        return null;
    }
    const receipt = selectPostReceipt(state, postId, readerId);
    if (receipt !== null) {
        return receipt;
    }

    const watermark = selectChannelWatermark(state, channelId, readerId);
    if (watermark && postCreateAt <= watermark.create_at) {
        return watermark.read_at;
    }

    return null;
}
