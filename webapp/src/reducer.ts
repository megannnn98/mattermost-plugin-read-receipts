import {PLUGIN_ID} from './client';
import {MMUserProfile, PluginAction, PluginConfig, PluginState, ReaderRead} from './types';

export type {PluginState, PostStatus} from './types';

const initialState: PluginState = {
    statuses: {},
    readers: {},
    profiles: {},
    profilesRevision: 0,
    config: null,
};

export const ACTION_TYPES = {
    RECEIPTS_QUERY: `${PLUGIN_ID}_RECEIPTS_QUERY`,
    WS_RECEIPT: `${PLUGIN_ID}_WS_RECEIPT`,
    POST_READERS: `${PLUGIN_ID}_POST_READERS`,
    PROFILES: `${PLUGIN_ID}_PROFILES`,
    CONFIG: `${PLUGIN_ID}_CONFIG`,
};

type QueryActionData = {
    channelId: string;
    posts?: Record<string, {count: number; truncated: boolean; read_at?: number}>;
    truncated?: boolean;
};

type WSReceiptActionData = {
    channel_id: string;
    post_id: string;
    read_at: number;
    reader_id: string;
    isDM: boolean;
};

type ReadersActionData = {
    postId: string;
    readers: ReaderRead[];
    truncated: boolean;
    nextOffset: number;
    append: boolean;
};

export function reducer(
    state: PluginState = initialState,
    action: PluginAction,
): PluginState {
    switch (action.type) {
        case ACTION_TYPES.RECEIPTS_QUERY: {
            const {posts = {}, truncated = false} = (action.data ?? {}) as QueryActionData;
            const statuses = {...state.statuses};
            for (const [postId, status] of Object.entries(posts)) {
                statuses[postId] = {
                    count: status.count,
                    truncated: status.truncated || truncated,
                    read_at: status.read_at ?? null,
                };
            }
            return {...state, statuses};
        }

        case ACTION_TYPES.WS_RECEIPT: {
            const {post_id, read_at, isDM} = (action.data ?? {}) as WSReceiptActionData;
            if (!post_id) {
                return state;
            }
            const existing = state.statuses[post_id];
            // A websocket receipt proves at least one person has read the post; it
            // does not say how many, because the count belongs to the server. In a
            // DM there is only ever one reader, so the event is the whole truth
            // there; elsewhere this is a floor that the next query replaces. Never
            // a decrement — a stale event must not walk the count backwards.
            const count = Math.max(existing?.count ?? 0, 1);
            const readAt = isDM ? read_at : (existing?.read_at ?? null);
            return {
                ...state,
                statuses: {
                    ...state.statuses,
                    [post_id]: {count, truncated: existing?.truncated ?? false, read_at: readAt},
                },
            };
        }

        case ACTION_TYPES.POST_READERS: {
            const data = (action.data ?? {}) as ReadersActionData;
            const previous = data.append ? state.readers[data.postId]?.list ?? [] : [];
            return {
                ...state,
                readers: {
                    ...state.readers,
                    [data.postId]: {
                        list: [...previous, ...data.readers],
                        truncated: data.truncated,
                        nextOffset: data.nextOffset,
                    },
                },
            };
        }

        case ACTION_TYPES.PROFILES: {
            const data = (action.data ?? {}) as {profiles: Record<string, MMUserProfile>};
            return {
                ...state,
                profiles: {...state.profiles, ...data.profiles},
                profilesRevision: state.profilesRevision + 1,
            };
        }

        case ACTION_TYPES.CONFIG: {
            const data = (action.data ?? {}) as {config: PluginConfig};
            return {...state, config: data.config};
        }

        default:
            return state;
    }
}
