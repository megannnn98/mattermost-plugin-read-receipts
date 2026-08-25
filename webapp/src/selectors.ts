import {GlobalState, PluginState, Watermark} from './types';
import {PLUGIN_ID} from './client';

const emptyPluginState: PluginState = {
    watermarks: {},
    receipts: {},
};

export function selectPluginState(state: GlobalState): PluginState {
    return (state[`plugins-${PLUGIN_ID}`] as PluginState | undefined) ?? emptyPluginState;
}

export function selectChannelWatermark(state: GlobalState, channelId: string): Watermark | null {
    const pluginState = selectPluginState(state);
    return pluginState.watermarks[channelId] ?? null;
}

export function selectPostReceipt(state: GlobalState, postId: string): number | null {
    const pluginState = selectPluginState(state);
    return pluginState.receipts[postId] ?? null;
}

export function isPostRead(state: GlobalState, postId: string, postCreateAt: number, channelId: string): boolean {
    const receipt = selectPostReceipt(state, postId);
    if (receipt !== null) {
        return true;
    }

    const watermark = selectChannelWatermark(state, channelId);
    if (watermark && postCreateAt <= watermark.create_at) {
        return true;
    }

    return false;
}

export function selectPostReadAt(state: GlobalState, postId: string, postCreateAt: number, channelId: string): number | null {
    const receipt = selectPostReceipt(state, postId);
    if (receipt !== null) {
        return receipt;
    }

    const watermark = selectChannelWatermark(state, channelId);
    if (watermark && postCreateAt <= watermark.create_at) {
        return watermark.read_at;
    }

    return null;
}
