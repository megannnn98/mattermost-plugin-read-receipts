// Minimal, locally defined views of the Mattermost webapp state, plugin store
// and plugin registry. Deliberately NOT the full mattermost-webapp package:
// only the fields this plugin actually reads are declared, so the webapp stays
// an implementation detail we are not tightly coupled to.

// --- Redux state shapes -----------------------------------------------------

/**
 * Everything the sender is allowed to know about one of their own posts.
 *
 * `count` is how many people have read it and `truncated` says that number is a
 * lower bound because the channel has more readers than one query covers. There
 * are deliberately no reader identities here: the server does not send them, and
 * the detailed list is fetched separately and only for the author.
 */
export interface PostStatus {
    count: number;
    truncated: boolean;
    read_at: number | null;
}

export interface ReaderRead {
    user_id: string;
    read_at: number;
    exact: boolean;
}

export interface ReaderList {
    list: ReaderRead[];
    truncated: boolean;
    nextOffset: number;
}

export interface PluginConfig {
    enabled_channel_types: string;
}

export interface PluginState {
    statuses: Record<string, PostStatus>;
    readers: Record<string, ReaderList>;
    // Bumped for a post whenever a websocket receipt invalidates its cached
    // reader list. `loadPostReaders` tags its dispatch with the epoch it started
    // from, and the reducer drops a page whose epoch is behind this — so a stale
    // in-flight response cannot overwrite the fresh list, only the WS event can.
    readersEpoch: Record<string, number>;
    profiles: Record<string, MMUserProfile>;
    // Bumped whenever `profiles` changes. Components select this instead of the
    // profile map so that a profile arriving after a popover is already open
    // re-renders it, without anything subscribing to the whole store.
    profilesRevision: number;
    config: PluginConfig | null;
}

export interface MMPost {
    id: string;
    user_id: string;
    channel_id: string;
    root_id?: string;
    create_at: number;
    update_at?: number;
    edit_at?: number;
    pending_post_id?: string;
    delete_at?: number;
    state?: string;
}

export interface MMChannel {
    id: string;
    type: string;
}

export interface MMUserProfile {
    id?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
    locale?: string;
}

export interface PostBlock {
    order: string[];
    recent?: boolean;
    oldest?: boolean;
}

export interface GlobalState {
    entities?: {
        posts?: {
            posts?: Record<string, MMPost>;
            postsInChannel?: Record<string, PostBlock[]>;
        };
        channels?: {
            currentChannelId?: string;
            channels?: Record<string, MMChannel>;
        };
        users?: {
            currentUserId?: string;
            profiles?: Record<string, MMUserProfile>;
        };
    };
    // Redux plugin branches are mounted under `plugins-<plugin_id>`.
    [branch: string]: unknown;
}

// --- Plugin store / actions -------------------------------------------------

export interface PluginAction<T = Record<string, unknown>> {
    type: string;
    data?: T;
}

export interface PluginStore {
    getState: () => GlobalState;
    dispatch: (action: PluginAction) => unknown;
    subscribe: (listener: () => void) => () => void;
}

// --- Webapp plugin registry -------------------------------------------------

export interface WebSocketMessage {
    event?: string;
    data?: {
        channel_id?: string;
        post_id?: string;
        create_at?: number | string;
        read_at?: number | string;
        reader_id?: string;
        author_id?: string;
    };
}

export interface PluginRegistry {
    registerReducer: (reducer: unknown) => void;
    registerWebSocketEventHandler: (event: string, handler: (msg: WebSocketMessage) => void) => void;
    registerPostMessageAttachmentComponent: (component: unknown) => void;
    registerReconnectHandler?: (handler: () => void) => void;
}
