import {PluginState} from './reducer';

export function selectPluginState(state: any): PluginState {
    return state['plugins-com.integrasources.read-receipts'] || {
        watermarks: {},
        receipts: {},
        debug: false,
    };
}

export function selectChannelWatermark(state: any, channelId: string) {
    const pluginState = selectPluginState(state);
    return pluginState.watermarks[channelId] || null;
}

export function selectPostReceipt(state: any, postId: string): number | null {
    const pluginState = selectPluginState(state);
    return pluginState.receipts[postId] ?? null;
}

export function isPostRead(state: any, postId: string, postCreateAt: number, channelId: string): boolean {
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

export function selectPostReadAt(state: any, postId: string, postCreateAt: number, channelId: string): number | null {
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
