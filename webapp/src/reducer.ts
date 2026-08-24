import {PLUGIN_ID} from './client';

export interface Watermark {
    post_id: string;
    create_at: number;
    read_at: number;
}

export interface PluginState {
    watermarks: Record<string, Watermark>;
    receipts: Record<string, number>;
    debug: boolean;
}

const initialState: PluginState = {
    watermarks: {},
    receipts: {},
    debug: false,
};

export const ACTION_TYPES = {
    RECEIPTS_QUERY: `${PLUGIN_ID}_RECEIPTS_QUERY`,
    WS_RECEIPT: `${PLUGIN_ID}_WS_RECEIPT`,
};

export function reducer(
    state: PluginState = initialState,
    action: {type: string; data?: any},
): PluginState {
    switch (action.type) {
        case ACTION_TYPES.RECEIPTS_QUERY: {
            const {channelId, watermark, receipts, debug} = action.data;
            const newWatermarks = {...state.watermarks};
            if (watermark) {
                const existing = newWatermarks[channelId];
                if (!existing || watermark.create_at > existing.create_at) {
                    newWatermarks[channelId] = watermark;
                }
            }
            return {
                ...state,
                watermarks: newWatermarks,
                receipts: {...state.receipts, ...receipts},
                debug: debug ?? state.debug,
            };
        }

        case ACTION_TYPES.WS_RECEIPT: {
            const {channel_id, post_id, create_at, read_at} = action.data;
            const newWatermarks = {...state.watermarks};
            const existing = newWatermarks[channel_id];
            if (!existing || create_at > existing.create_at) {
                newWatermarks[channel_id] = {
                    post_id,
                    create_at,
                    read_at,
                };
            }
            return {
                ...state,
                watermarks: newWatermarks,
                receipts: {...state.receipts, [post_id]: read_at},
            };
        }

        default:
            return state;
    }
}
