import {getDeduplicator, resetDeduplicator} from '../src/actions';

describe('deduplication', () => {
    beforeEach(() => {
        resetDeduplicator();
    });

    it('allows first send', () => {
        const dedup = getDeduplicator();
        expect(dedup.shouldSend('ch1', 'p1', 1000)).toBe(true);
    });

    it('blocks duplicate for same post', () => {
        const dedup = getDeduplicator();
        dedup.markSent('ch1', 'p1', 1000);
        expect(dedup.shouldSend('ch1', 'p1', 1000)).toBe(false);
    });

    it('blocks older posts in same channel', () => {
        const dedup = getDeduplicator();
        dedup.markSent('ch1', 'p2', 2000);
        expect(dedup.shouldSend('ch1', 'p1', 1000)).toBe(false);
    });

    it('allows newer posts in same channel', () => {
        const dedup = getDeduplicator();
        dedup.markSent('ch1', 'p1', 1000);
        expect(dedup.shouldSend('ch1', 'p2', 2000)).toBe(true);
    });

    it('allows same post in different channel', () => {
        const dedup = getDeduplicator();
        dedup.markSent('ch1', 'p1', 1000);
        expect(dedup.shouldSend('ch2', 'p1', 1000)).toBe(true);
    });
});
