import {reducer, ACTION_TYPES} from '../src/reducer';
import {PLUGIN_ID} from '../src/client';

describe('reducer', () => {
    it('returns initial state', () => {
        const state = reducer(undefined, {type: 'UNKNOWN'});
        expect(state).toEqual({
            watermarks: {},
            receipts: {},
            readers: {},
            profiles: {},
        });
    });

    it('action types include plugin ID prefix', () => {
        expect(ACTION_TYPES.RECEIPTS_QUERY).toBe(`${PLUGIN_ID}_RECEIPTS_QUERY`);
        expect(ACTION_TYPES.WS_RECEIPT).toBe(`${PLUGIN_ID}_WS_RECEIPT`);
    });

    it('handles RECEIPTS_QUERY with watermark', () => {
        const state = reducer(undefined, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId: 'ch1',
                watermarks: [{
                    reader_id: 'reader',
                    post_id: 'p1',
                    create_at: 1000,
                    read_at: 2000,
                }],
                receipts: {p1: {reader: 2000}},
            },
        });

        expect(state.watermarks['ch1'].reader).toEqual({
            reader_id: 'reader',
            post_id: 'p1',
            create_at: 1000,
            read_at: 2000,
        });
        expect(state.receipts['p1'].reader).toBe(2000);
    });

    it('enforces watermark monotonicity', () => {
        let state = reducer(undefined, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId: 'ch1',
                watermarks: [{reader_id: 'reader', post_id: 'p1', create_at: 1000, read_at: 2000}],
                receipts: {},
            },
        });

        state = reducer(state, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId: 'ch1',
                watermarks: [{reader_id: 'reader', post_id: 'p2', create_at: 500, read_at: 1500}],
                receipts: {},
            },
        });

        expect(state.watermarks['ch1'].reader.create_at).toBe(1000);
    });

    it('handles WS_RECEIPT event', () => {
        const state = reducer(undefined, {
            type: ACTION_TYPES.WS_RECEIPT,
            data: {
                channel_id: 'ch1',
                post_id: 'p1',
                create_at: 1000,
                read_at: 2000,
                reader_id: 'reader',
            },
        });

        expect(state.watermarks['ch1'].reader).toEqual({
            reader_id: 'reader',
            post_id: 'p1',
            create_at: 1000,
            read_at: 2000,
        });
        expect(state.receipts['p1'].reader).toBe(2000);
    });
    it('keeps the readers of a channel independent of each other', () => {
        const first = reducer(undefined, {
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'ch1', post_id: 'p1', create_at: 1000, read_at: 1100, reader_id: 'a'},
        });
        const second = reducer(first, {
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'ch1', post_id: 'p1', create_at: 2000, read_at: 2100, reader_id: 'b'},
        });

        expect(Object.keys(second.watermarks.ch1).sort()).toEqual(['a', 'b']);
        expect(second.receipts.p1).toEqual({a: 1100, b: 2100});
    });

    it('never moves a single reader watermark backwards', () => {
        const ahead = reducer(undefined, {
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'ch1', post_id: 'p2', create_at: 5000, read_at: 5100, reader_id: 'a'},
        });
        const behind = reducer(ahead, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId: 'ch1',
                watermarks: [{reader_id: 'a', post_id: 'p1', create_at: 1000, read_at: 1100}],
            },
        });

        expect(behind.watermarks.ch1.a.create_at).toBe(5000);
    });

    it('merges per-post receipts of different readers instead of replacing them', () => {
        const first = reducer(undefined, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {channelId: 'ch1', receipts: {p1: {a: 1000}}},
        });
        const second = reducer(first, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {channelId: 'ch1', receipts: {p1: {b: 2000}}},
        });

        expect(second.receipts.p1).toEqual({a: 1000, b: 2000});
    });

    it('stores the reader detail of a post and the profiles behind it', () => {
        const withReaders = reducer(undefined, {
            type: ACTION_TYPES.POST_READERS,
            data: {postId: 'p1', readers: [{user_id: 'a', read_at: 1000, exact: true}], truncated: true},
        });
        const withProfiles = reducer(withReaders, {
            type: ACTION_TYPES.PROFILES,
            data: {profiles: {a: {username: 'ada'}}},
        });

        expect(withProfiles.readers.p1).toEqual({
            list: [{user_id: 'a', read_at: 1000, exact: true}],
            truncated: true,
        });
        expect(withProfiles.profiles.a).toEqual({username: 'ada'});
    });
});
