import {PLUGIN_ID} from '../src/client';
import {GlobalState, PluginState} from '../src/types';

export const BRANCH = `plugins-${PLUGIN_ID}`;

export function pluginBranch(overrides: Partial<PluginState> = {}): PluginState {
    return {
        statuses: {},
        readers: {},
        profiles: {},
        profilesRevision: 0,
        config: {enabled_channel_types: 'DGPO'},
        ...overrides,
    };
}

interface StateOptions {
    currentUserId?: string;
    currentChannelId?: string;
    channels?: Record<string, {id: string; type: string}>;
    posts?: Record<string, Record<string, unknown>>;
    profiles?: Record<string, Record<string, unknown>>;
    plugin?: Partial<PluginState>;
}

export function makeGlobalState(options: StateOptions = {}): GlobalState {
    return {
        entities: {
            users: {currentUserId: options.currentUserId ?? 'me', profiles: (options.profiles ?? {}) as never},
            channels: {
                currentChannelId: options.currentChannelId ?? 'ch1',
                channels: (options.channels ?? {ch1: {id: 'ch1', type: 'D'}}) as never,
            },
            posts: {posts: (options.posts ?? {}) as never},
        },
        [BRANCH]: pluginBranch(options.plugin),
    };
}
