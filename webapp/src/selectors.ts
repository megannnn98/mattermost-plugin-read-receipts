import {GlobalState, PluginConfig, PluginState, PostStatus, ReaderList} from './types';
import {PLUGIN_ID} from './client';

const EMPTY_STATUS: PostStatus = {count: 0, truncated: false, read_at: null};

const emptyPluginState: PluginState = {
    statuses: {},
    readers: {},
    readersEpoch: {},
    profiles: {},
    profilesRevision: 0,
    config: null,
};

export function selectPluginState(state: GlobalState): PluginState {
    return (state[`plugins-${PLUGIN_ID}`] as PluginState | undefined) ?? emptyPluginState;
}

export function selectPostStatus(state: GlobalState, postId: string): PostStatus {
    return selectPluginState(state).statuses[postId] ?? EMPTY_STATUS;
}

export function selectPostReaders(state: GlobalState, postId: string): ReaderList | undefined {
    return selectPluginState(state).readers[postId];
}

/**
 * The reader-list epoch of a post: incremented each time a websocket receipt
 * invalidates that post's cached list. Requesting actions capture it up front so
 * the reducer can tell a response that started before an invalidation from one
 * that started after it (see `readersEpoch` in PluginState).
 */
export function selectReadersEpoch(state: GlobalState, postId: string): number {
    return selectPluginState(state).readersEpoch?.[postId] ?? 0;
}

export function selectProfilesRevision(state: GlobalState): number {
    return selectPluginState(state).profilesRevision;
}

export function selectPluginConfig(state: GlobalState): PluginConfig | null {
    return selectPluginState(state).config;
}

/**
 * The channel types the server is collecting receipts for.
 *
 * Returns null until the configuration has been fetched. Callers must treat that
 * as "not yet known" and stay inert rather than guessing: assuming a type is
 * enabled would report reads the server is about to refuse, and assuming it is
 * disabled would flash an indicator off and on again.
 */
export function selectEnabledChannelTypes(state: GlobalState): string | null {
    return selectPluginConfig(state)?.enabled_channel_types ?? null;
}

export function isChannelTypeEnabled(state: GlobalState, channelType: string | undefined): boolean {
    const enabled = selectEnabledChannelTypes(state);
    if (!enabled || !channelType) {
        return false;
    }
    return enabled.includes(channelType);
}

/**
 * A profile for the reader list: the plugin's own copy first, the webapp's own
 * store as a fallback, so a user the webapp already knows costs no request.
 */
export function selectReaderProfile(state: GlobalState, userId: string) {
    return selectPluginState(state).profiles[userId] ?? state.entities?.users?.profiles?.[userId];
}
