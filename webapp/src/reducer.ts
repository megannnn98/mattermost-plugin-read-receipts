import {PLUGIN_ID} from './client';
import {PluginAction, PluginState, Watermark} from './types';

export type {PluginState, Watermark} from './types';

const initialState: PluginState = {
    watermarks: {},
    receipts: {},
    debug: false,
};

export const ACTION_TYPES = {
    RECEIPTS_QUERY: `${PLUGIN_ID}_RECEIPTS_QUERY`,
    WS_RECEIPT: `${PLUGIN_ID}_WS_RECEIPT`,
};

type QueryActionData = {
    channelId: string;
    watermark?: Watermark;
    receipts?: Record<string, number>;
    debug?: boolean;
};

type WSReceiptActionData = {
    channel_id: string;
    post_id: string;
    create_at: number;
    read_at: number;
};

export function reducer(
    state: PluginState = initialState,
    action: PluginAction,
): PluginState {
    switch (action.type) {
        case ACTION_TYPES.RECEIPTS_QUERY: {
            const {channelId, watermark, receipts = {}, debug} = (action.data ?? {}) as QueryActionData;
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
            const {channel_id, post_id, create_at, read_at} = (action.data ?? {}) as WSReceiptActionData;
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
