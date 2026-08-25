import {
    isChannelTypeEnabled,
    selectEnabledChannelTypes,
    selectPostReaders,
    selectPostStatus,
    selectProfilesRevision,
    selectReaderProfile,
} from '../src/selectors';
import {makeGlobalState} from './helpers';

describe('selectors', () => {
    it('reports an empty status for a post nothing is known about', () => {
        const state = makeGlobalState();
        expect(selectPostStatus(state, 'p1')).toEqual({count: 0, truncated: false, read_at: null});
    });

    it('returns the stored status of a post', () => {
        const state = makeGlobalState({
            plugin: {statuses: {p1: {count: 3, truncated: true, read_at: 4000}}},
        });
        expect(selectPostStatus(state, 'p1')).toEqual({count: 3, truncated: true, read_at: 4000});
    });

    it('returns the cached reader list of a post', () => {
        const list = {list: [{user_id: 'a', read_at: 1, exact: true}], truncated: false, nextOffset: 0};
        const state = makeGlobalState({plugin: {readers: {p1: list}}});
        expect(selectPostReaders(state, 'p1')).toBe(list);
        expect(selectPostReaders(state, 'p2')).toBeUndefined();
    });

    it('exposes the profile revision so a late profile can trigger a render', () => {
        expect(selectProfilesRevision(makeGlobalState({plugin: {profilesRevision: 7}}))).toBe(7);
    });

    it('prefers the plugin profile and falls back to the webapp store', () => {
        const state = makeGlobalState({
            profiles: {webapp: {username: 'fromWebapp'}, both: {username: 'webappCopy'}},
            plugin: {profiles: {plugin: {username: 'fromPlugin'}, both: {username: 'pluginCopy'}}},
        });
        expect(selectReaderProfile(state, 'plugin')?.username).toBe('fromPlugin');
        expect(selectReaderProfile(state, 'webapp')?.username).toBe('fromWebapp');
        expect(selectReaderProfile(state, 'both')?.username).toBe('pluginCopy');
        expect(selectReaderProfile(state, 'nobody')).toBeUndefined();
    });

    describe('enabled channel types', () => {
        it('is unknown until the configuration has been fetched', () => {
            const state = makeGlobalState({plugin: {config: null}});
            expect(selectEnabledChannelTypes(state)).toBeNull();
            // Unknown must not read as enabled: the plugin has to stay inert
            // rather than report reads the server is about to refuse.
            for (const type of ['D', 'G', 'P', 'O']) {
                expect(isChannelTypeEnabled(state, type)).toBe(false);
            }
        });

        it('follows the server configuration exactly', () => {
            const state = makeGlobalState({plugin: {config: {enabled_channel_types: 'DG'}}});
            expect(isChannelTypeEnabled(state, 'D')).toBe(true);
            expect(isChannelTypeEnabled(state, 'G')).toBe(true);
            expect(isChannelTypeEnabled(state, 'P')).toBe(false);
            expect(isChannelTypeEnabled(state, 'O')).toBe(false);
            expect(isChannelTypeEnabled(state, undefined)).toBe(false);
        });
    });
});
