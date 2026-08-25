import {getDeduplicator, resetDeduplicator, sendReadReceipt} from '../src/actions';
import * as client from '../src/client';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn().mockResolvedValue({watermark: null, receipts: {}}),
    reportRead: jest.fn(),
}));

const mockedReportRead = client.reportRead as jest.MockedFunction<typeof client.reportRead>;

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

describe('sendReadReceipt', () => {
    beforeEach(() => {
        resetDeduplicator();
        mockedReportRead.mockReset();
        mockedReportRead.mockResolvedValue({
            post_id: 'p1',
            channel_id: 'ch1',
            create_at: 1000,
            read_at: 2000,
        });
    });

    it('returns true on a successful reportRead and marks the read as sent', async () => {
        expect(await sendReadReceipt('ch1', 'p1', 1000)).toBe(true);
        expect(mockedReportRead).toHaveBeenCalledWith('p1');
        // A subsequent send is deduplicated (already sent) — still true, no new request.
        expect(await sendReadReceipt('ch1', 'p1', 1000)).toBe(true);
        expect(mockedReportRead).toHaveBeenCalledTimes(1);
    });

    it('returns true without a request when it was already sent (dedup)', async () => {
        const dedup = getDeduplicator();
        dedup.markSent('ch1', 'p1', 1000);
        expect(await sendReadReceipt('ch1', 'p1', 1000)).toBe(true);
        expect(mockedReportRead).not.toHaveBeenCalled();
    });

    it('returns false when the request fails', async () => {
        mockedReportRead.mockRejectedValue(new Error('network down'));
        expect(await sendReadReceipt('ch1', 'p1', 1000)).toBe(false);
        // The failure must not mark the post as sent, so a retry can resend.
        expect(await sendReadReceipt('ch1', 'p1', 1000)).toBe(false);
        expect(mockedReportRead).toHaveBeenCalledTimes(2);
    });
});
