import {PLUGIN_ID} from './client';
import {MMUserProfile, PluginAction, PluginConfig, PluginState, ReaderRead} from './types';

export type {PluginState, PostStatus} from './types';

const initialState: PluginState = {
    statuses: {},
    readers: {},
    readersEpoch: {},
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
    CONFIG_LOADING: `${PLUGIN_ID}_CONFIG_LOADING`,
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
    // The reader-list epoch this page was fetched against (see `readersEpoch`).
    // A page started before a websocket invalidation carries the old epoch and
    // is dropped, never allowed to overwrite the fresh state.
    epoch?: number;
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
            // A live receipt proves a new reader reached this post, so any cached
            // reader *list* for it is stale by definition. Drop it here and bump
            // the post's epoch, which both re-triggers the open popover's reload
            // and makes the reducer reject any page a still-in-flight request
            // started before this event. Without the epoch, a response issued
            // just before the WS could land after it and overwrite the fresh list
            // with the old one.
            const readers = {...state.readers};
            delete readers[post_id];
            const readersEpoch = {...state.readersEpoch};
            readersEpoch[post_id] = (state.readersEpoch[post_id] ?? 0) + 1;
            return {
                ...state,
                statuses: {
                    ...state.statuses,
                    [post_id]: {count, truncated: existing?.truncated ?? false, read_at: readAt},
                },
                readers,
                readersEpoch,
            };
        }

        case ACTION_TYPES.POST_READERS: {
            const data = (action.data ?? {}) as ReadersActionData;
            // Reject a page issued against a stale generation: a websocket receipt
            // invalidated this post after the request began, so its content is
            // outdated and must not overwrite the fresh (or still-missing) list.
            // A missing epoch defaults to 0 and is only ever equal-or-newer on the
            // very first fetch, which keeps existing dispatches working.
            const epoch = data.epoch ?? 0;
            if (epoch < (state.readersEpoch[data.postId] ?? 0)) {
                return state;
            }
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

        // Never retain an old allow-list across reconnect. Until the next config
        // response arrives, every gate sees config=null and the plugin is inert.
        case ACTION_TYPES.CONFIG_LOADING:
            return {...state, config: null};

        default:
            return state;
    }
}
