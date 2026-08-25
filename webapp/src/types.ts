// Minimal, locally defined views of the Mattermost webapp state, plugin store
// and plugin registry. Deliberately NOT the full mattermost-webapp package:
// only the fields this plugin actually reads are declared, so the webapp stays
// an implementation detail we are not tightly coupled to.

// --- Redux state shapes -----------------------------------------------------

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

export interface MMPost {
    id: string;
    user_id: string;
    channel_id: string;
    create_at: number;
    delete_at?: number;
    state?: string;
}

export interface MMChannel {
    id: string;
    type: string;
}

export interface MMUserProfile {
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
