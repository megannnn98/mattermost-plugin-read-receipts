import {isPostRead, selectPostReadAt} from '../src/selectors';

describe('selectors', () => {
    const makeState = (overrides: any = {}) => ({
        'plugins-com.integrasources.read-receipts': {
            watermarks: {},
            receipts: {},
            debug: false,
            ...overrides,
        },
    });

    it('isPostRead returns false when no data', () => {
        const state = makeState();
        expect(isPostRead(state, 'p1', 1000, 'ch1')).toBe(false);
    });

    it('isPostRead returns true when receipt exists', () => {
        const state = makeState({receipts: {p1: 2000}});
        expect(isPostRead(state, 'p1', 1000, 'ch1')).toBe(true);
    });

    it('isPostRead returns true when post is covered by watermark', () => {
        const state = makeState({
            watermarks: {ch1: {post_id: 'p2', create_at: 1500, read_at: 3000}},
        });
        expect(isPostRead(state, 'p1', 1000, 'ch1')).toBe(true);
    });

    it('isPostRead returns false when post is newer than watermark', () => {
        const state = makeState({
            watermarks: {ch1: {post_id: 'p1', create_at: 1500, read_at: 3000}},
        });
        expect(isPostRead(state, 'p2', 2000, 'ch1')).toBe(false);
    });

    it('selectPostReadAt returns exact time from receipt', () => {
        const state = makeState({receipts: {p1: 2000}});
        expect(selectPostReadAt(state, 'p1', 1000, 'ch1')).toBe(2000);
    });

    it('selectPostReadAt returns watermark time when covered', () => {
        const state = makeState({
            watermarks: {ch1: {post_id: 'p2', create_at: 1500, read_at: 3000}},
        });
        expect(selectPostReadAt(state, 'p1', 1000, 'ch1')).toBe(3000);
    });

    it('selectPostReadAt returns null when not read', () => {
        const state = makeState();
        expect(selectPostReadAt(state, 'p1', 1000, 'ch1')).toBeNull();
    });
});
