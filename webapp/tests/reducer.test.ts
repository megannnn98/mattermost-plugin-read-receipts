import {reducer, ACTION_TYPES} from '../src/reducer';
import {PLUGIN_ID} from '../src/client';

describe('reducer', () => {
    it('returns initial state', () => {
        const state = reducer(undefined, {type: 'UNKNOWN'});
        expect(state).toEqual({
            watermarks: {},
            receipts: {},
            debug: false,
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
                watermark: {
                    post_id: 'p1',
                    create_at: 1000,
                    read_at: 2000,
                },
                receipts: {p1: 2000},
                debug: false,
            },
        });

        expect(state.watermarks['ch1']).toEqual({
            post_id: 'p1',
            create_at: 1000,
            read_at: 2000,
        });
        expect(state.receipts['p1']).toBe(2000);
    });

    it('enforces watermark monotonicity', () => {
        let state = reducer(undefined, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId: 'ch1',
                watermark: {post_id: 'p1', create_at: 1000, read_at: 2000},
                receipts: {},
                debug: false,
            },
        });

        state = reducer(state, {
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {
                channelId: 'ch1',
                watermark: {post_id: 'p2', create_at: 500, read_at: 1500},
                receipts: {},
                debug: false,
            },
        });

        expect(state.watermarks['ch1'].create_at).toBe(1000);
    });

    it('handles WS_RECEIPT event', () => {
        const state = reducer(undefined, {
            type: ACTION_TYPES.WS_RECEIPT,
            data: {
                channel_id: 'ch1',
                post_id: 'p1',
                create_at: 1000,
                read_at: 2000,
            },
        });

        expect(state.watermarks['ch1']).toEqual({
            post_id: 'p1',
            create_at: 1000,
            read_at: 2000,
        });
        expect(state.receipts['p1']).toBe(2000);
    });
});
