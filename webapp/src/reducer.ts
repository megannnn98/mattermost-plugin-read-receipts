import {PLUGIN_ID} from './client';
import {PluginAction, PluginState, ReaderRead, Watermark} from './types';

export type {PluginState, Watermark} from './types';

const initialState: PluginState = {
    watermarks: {},
    receipts: {},
    readers: {},
    profiles: {},
};

export const ACTION_TYPES = {
    RECEIPTS_QUERY: `${PLUGIN_ID}_RECEIPTS_QUERY`,
    WS_RECEIPT: `${PLUGIN_ID}_WS_RECEIPT`,
    POST_READERS: `${PLUGIN_ID}_POST_READERS`,
    PROFILES: `${PLUGIN_ID}_PROFILES`,
};

type QueryActionData = {channelId: string; watermarks?: Watermark[]; receipts?: Record<string, Record<string, number>>};

type WSReceiptActionData = {
    channel_id: string;
    post_id: string;
    create_at: number;
    read_at: number;
    reader_id: string;
};

export function reducer(
    state: PluginState = initialState,
    action: PluginAction,
): PluginState {
    switch (action.type) {
        case ACTION_TYPES.RECEIPTS_QUERY: {
            const {channelId, watermarks = [], receipts = {}} = (action.data ?? {}) as QueryActionData;
            const newWatermarks = {...state.watermarks};
            const channelWatermarks = {...(newWatermarks[channelId] ?? {})};
            for (const watermark of watermarks) {
                const existing = channelWatermarks[watermark.reader_id];
                if (!existing || watermark.create_at > existing.create_at) {
                    channelWatermarks[watermark.reader_id] = watermark;
                }
            }
            newWatermarks[channelId] = channelWatermarks;
            const mergedReceipts = {...state.receipts};
            for (const [postId, byReader] of Object.entries(receipts)) {
                mergedReceipts[postId] = {...(mergedReceipts[postId] ?? {}), ...byReader};
            }
            return {
                ...state,
                watermarks: newWatermarks,
                receipts: mergedReceipts,
            };
        }

        case ACTION_TYPES.WS_RECEIPT: {
            const {channel_id, post_id, create_at, read_at, reader_id} = (action.data ?? {}) as WSReceiptActionData;
            const newWatermarks = {...state.watermarks};
            const channelWatermarks = {...(newWatermarks[channel_id] ?? {})};
            const existing = channelWatermarks[reader_id];
            if (!existing || create_at > existing.create_at) {
                channelWatermarks[reader_id] = {
                    reader_id,
                    post_id,
                    create_at,
                    read_at,
                };
            }
            newWatermarks[channel_id] = channelWatermarks;
            return {
                ...state,
                watermarks: newWatermarks,
                receipts: {...state.receipts, [post_id]: {...(state.receipts[post_id] ?? {}), [reader_id]: read_at}},
            };
        }

        case ACTION_TYPES.POST_READERS: {
            const data = (action.data ?? {}) as {postId: string; readers: ReaderRead[]; truncated: boolean};
            return {...state, readers: {...state.readers, [data.postId]: {list: data.readers, truncated: data.truncated}}};
        }

        case ACTION_TYPES.PROFILES: {
            const data = (action.data ?? {}) as {profiles: PluginState['profiles']};
            return {...state, profiles: {...state.profiles, ...data.profiles}};
        }

        default:
            return state;
    }
}
