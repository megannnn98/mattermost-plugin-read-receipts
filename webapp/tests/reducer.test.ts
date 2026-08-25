import {reducer, ACTION_TYPES} from '../src/reducer';
import {PLUGIN_ID} from '../src/client';

describe('reducer', () => {
    it('returns initial state', () => {
        expect(reducer(undefined, {type: 'UNKNOWN'})).toEqual({
            statuses: {},
            readers: {},
            profiles: {},
            profilesRevision: 0,
            config: null,
        });
    });

    it('action types include plugin ID prefix', () => {
        expect(ACTION_TYPES.RECEIPTS_QUERY).toBe(`${PLUGIN_ID}_RECEIPTS_QUERY`);
        expect(ACTION_TYPES.WS_RECEIPT).toBe(`${PLUGIN_ID}_WS_RECEIPT`);
        expect(ACTION_TYPES.CONFIG).toBe(`${PLUGIN_ID}_CONFIG`);
    });

    it('stores the per-post status a query returned', () => {
        const state = reducer(undefined, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId: 'ch1',
                posts: {p1: {count: 2, truncated: false, read_at: 4000}, p2: {count: 0, truncated: false}},
            },
        });

        expect(state.statuses.p1).toEqual({count: 2, truncated: false, read_at: 4000});
        expect(state.statuses.p2).toEqual({count: 0, truncated: false, read_at: null});
    });

    it('marks every post of a truncated channel as a lower bound', () => {
        const state = reducer(undefined, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {channelId: 'ch1', posts: {p1: {count: 200, truncated: false}}, truncated: true},
        });

        expect(state.statuses.p1.truncated).toBe(true);
    });

    describe('websocket receipts', () => {
        it('takes a DM event as the whole truth', () => {
            const state = reducer(undefined, {
                type: ACTION_TYPES.WS_RECEIPT,
                data: {channel_id: 'ch1', post_id: 'p1', read_at: 2000, reader_id: 'a', isDM: true},
            });

            expect(state.statuses.p1).toEqual({count: 1, truncated: false, read_at: 2000});
        });

        it('treats a group event as a floor, not as a count', () => {
            const queried = reducer(undefined, {
                type: ACTION_TYPES.RECEIPTS_QUERY,
                data: {channelId: 'ch1', posts: {p1: {count: 5, truncated: false}}},
            });
            const after = reducer(queried, {
                type: ACTION_TYPES.WS_RECEIPT,
                data: {channel_id: 'ch1', post_id: 'p1', read_at: 9000, reader_id: 'b', isDM: false},
            });

            // The event proves somebody read it; it does not say how many people
            // have, so a stale event must never walk an accurate count backwards.
            expect(after.statuses.p1.count).toBe(5);
            expect(after.statuses.p1.read_at).toBeNull();
        });

        it('raises an unknown post to at least one reader', () => {
            const state = reducer(undefined, {
                type: ACTION_TYPES.WS_RECEIPT,
                data: {channel_id: 'ch1', post_id: 'p1', read_at: 9000, reader_id: 'b', isDM: false},
            });
            expect(state.statuses.p1.count).toBe(1);
        });

        it('ignores an event without a post id', () => {
            const before = reducer(undefined, {type: 'UNKNOWN'});
            expect(reducer(before, {type: ACTION_TYPES.WS_RECEIPT, data: {reader_id: 'b'}})).toBe(before);
        });
    });

    describe('reader lists', () => {
        const page = (users: string[], truncated: boolean, nextOffset: number, append: boolean) => ({
            type: ACTION_TYPES.POST_READERS,
            data: {
                postId: 'p1',
                readers: users.map((user_id) => ({user_id, read_at: 1000, exact: true})),
                truncated,
                nextOffset,
                append,
            },
        });

        it('stores the first page', () => {
            const state = reducer(undefined, page(['a', 'b'], true, 200, false));
            expect(state.readers.p1.list.map((r) => r.user_id)).toEqual(['a', 'b']);
            expect(state.readers.p1).toMatchObject({truncated: true, nextOffset: 200});
        });

        it('appends a continuation instead of replacing it', () => {
            const first = reducer(undefined, page(['a'], true, 200, false));
            const second = reducer(first, page(['b'], false, 0, true));
            expect(second.readers.p1.list.map((r) => r.user_id)).toEqual(['a', 'b']);
            expect(second.readers.p1).toMatchObject({truncated: false, nextOffset: 0});
        });

        it('replaces the list when the popover is reopened from the start', () => {
            const first = reducer(undefined, page(['a', 'b'], false, 0, false));
            const reopened = reducer(first, page(['a'], false, 0, false));
            expect(reopened.readers.p1.list.map((r) => r.user_id)).toEqual(['a']);
        });
    });

    it('bumps a revision when profiles arrive so an open list can re-render', () => {
        const state = reducer(undefined, {
            type: ACTION_TYPES.PROFILES,
            data: {profiles: {a: {username: 'ada'}}},
        });
        expect(state.profiles.a).toEqual({username: 'ada'});
        expect(state.profilesRevision).toBe(1);

        const again = reducer(state, {type: ACTION_TYPES.PROFILES, data: {profiles: {b: {username: 'bob'}}}});
        expect(again.profilesRevision).toBe(2);
        expect(again.profiles).toEqual({a: {username: 'ada'}, b: {username: 'bob'}});
    });

    it('stores the plugin configuration', () => {
        const state = reducer(undefined, {
            type: ACTION_TYPES.CONFIG,
            data: {config: {enabled_channel_types: 'DG'}},
        });
        expect(state.config).toEqual({enabled_channel_types: 'DG'});
    });
});
