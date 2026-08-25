import {selectPostReadCount, selectSingleReaderReadAt} from '../src/selectors';

describe('selectors', () => {
    const makeState = (overrides: any = {}) => ({
        'plugins-com.integrasources.read-receipts': {
            watermarks: {},
            receipts: {},
            readers: {},
            profiles: {},
            ...overrides,
        },
        entities: {
            users: {currentUserId: 'me'},
        },
    });

    it('returns zero when no reader covers the post', () => {
        const state = makeState();
        expect(selectPostReadCount(state, 'p1', 1000, 'ch1', 'author')).toBe(0);
    });

    it('counts only readers other than author and current user', () => {
        const state = makeState({receipts: {p1: {reader: 2000, author: 2000, me: 2000}}});
        expect(selectPostReadCount(state, 'p1', 1000, 'ch1', 'author')).toBe(1);
    });

    it('counts a reader whose watermark covers the post', () => {
        const state = makeState({
            watermarks: {ch1: {reader: {reader_id: 'reader', post_id: 'p2', create_at: 1500, read_at: 3000}}},
        });
        expect(selectPostReadCount(state, 'p1', 1000, 'ch1', 'author')).toBe(1);
    });

    it('does not count a reader whose watermark is older than the post', () => {
        const state = makeState({
            watermarks: {ch1: {reader: {reader_id: 'reader', post_id: 'p1', create_at: 1500, read_at: 3000}}},
        });
        expect(selectPostReadCount(state, 'p2', 2000, 'ch1', 'author')).toBe(0);
    });

    it('selectSingleReaderReadAt returns exact time from the DM reader', () => {
        const state = makeState({receipts: {p1: {reader: 2000}}});
        expect(selectSingleReaderReadAt(state, 'p1', 1000, 'ch1')).toBe(2000);
    });

    it('selectSingleReaderReadAt returns watermark time when covered', () => {
        const state = makeState({
            watermarks: {ch1: {reader: {reader_id: 'reader', post_id: 'p2', create_at: 1500, read_at: 3000}}},
        });
        expect(selectSingleReaderReadAt(state, 'p1', 1000, 'ch1')).toBe(3000);
    });

    it('selectSingleReaderReadAt returns null when not read', () => {
        const state = makeState();
        expect(selectSingleReaderReadAt(state, 'p1', 1000, 'ch1')).toBeNull();
    });
});
