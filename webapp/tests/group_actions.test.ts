import {loadChannelReceipts, loadPostReaders, resetDeduplicator, sendReadReceipt} from '../src/actions';
import {ACTION_TYPES} from '../src/reducer';
import * as client from '../src/client';
import {RequestError} from '../src/client';

jest.mock('../src/client', () => {
    class MockRequestError extends Error {
        constructor(public readonly status: number, message: string) {
            super(message);
        }
    }
    return {
        PLUGIN_ID: 'com.integrasources.read-receipts',
        RequestError: MockRequestError,
        fetchChannelReceipts: jest.fn(),
        fetchPostReaders: jest.fn(),
        fetchUsersByIds: jest.fn(),
        reportRead: jest.fn(),
    };
});

const mockedReportRead = client.reportRead as jest.MockedFunction<typeof client.reportRead>;
const mockedQuery = client.fetchChannelReceipts as jest.MockedFunction<typeof client.fetchChannelReceipts>;
const mockedPostReaders = client.fetchPostReaders as jest.MockedFunction<typeof client.fetchPostReaders>;
const mockedUsers = client.fetchUsersByIds as jest.MockedFunction<typeof client.fetchUsersByIds>;

const PLUGIN_BRANCH = 'plugins-com.integrasources.read-receipts';

function makeStore(profiles: Record<string, unknown> = {}, pluginProfiles: Record<string, unknown> = {}) {
    return {
        getState: () => ({
            entities: {users: {currentUserId: 'me', profiles}},
            [PLUGIN_BRANCH]: {watermarks: {}, receipts: {}, readers: {}, profiles: pluginProfiles},
        }),
        dispatch: jest.fn(),
        subscribe: jest.fn().mockReturnValue(() => undefined),
    } as any;
}

beforeEach(() => {
    resetDeduplicator();
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    (console.error as jest.Mock).mockRestore();
});

describe('403 is a permanent answer, not a transient failure', () => {
    it('stops the watcher from backing off forever on a disabled channel type', async () => {
        mockedQuery.mockRejectedValue(new RequestError(403, 'forbidden'));

        // "true" means handled: the watcher marks the channel done instead of
        // retrying a request that can only ever be refused.
        expect(await loadChannelReceipts(makeStore(), 'ch1', ['p1'])).toBe(true);
    });

    it('still reports a transient failure so the backoff can retry', async () => {
        mockedQuery.mockRejectedValue(new RequestError(500, 'boom'));

        expect(await loadChannelReceipts(makeStore(), 'ch1', ['p1'])).toBe(false);
    });

    it('does not re-send a read the server refuses', async () => {
        mockedReportRead.mockRejectedValue(new RequestError(403, 'forbidden'));

        expect(await sendReadReceipt('ch1', 'p1', 1000)).toBe(true);
        expect(await sendReadReceipt('ch1', 'p1', 1000)).toBe(true);
        expect(mockedReportRead).toHaveBeenCalledTimes(1);
    });
});

describe('loadPostReaders', () => {
    it('stores the reader list and loads only the profiles it does not have', async () => {
        mockedPostReaders.mockResolvedValue({
            readers: [
                {user_id: 'known', read_at: 1000, exact: true},
                {user_id: 'cached', read_at: 1100, exact: false},
                {user_id: 'fresh', read_at: 1200, exact: true},
            ],
            truncated: false,
        });
        mockedUsers.mockResolvedValue([{id: 'fresh', username: 'fresh'}]);

        const store = makeStore({known: {username: 'known'}}, {cached: {username: 'cached'}});
        await loadPostReaders(store, 'p1');

        expect(store.dispatch).toHaveBeenCalledWith({
            type: ACTION_TYPES.POST_READERS,
            data: {postId: 'p1', readers: expect.any(Array), truncated: false},
        });
        // Both the webapp's own profiles and the ones this plugin already fetched
        // count as known, otherwise every popover open refetches the same users.
        expect(mockedUsers).toHaveBeenCalledWith(['fresh']);
        expect(store.dispatch).toHaveBeenCalledWith({
            type: ACTION_TYPES.PROFILES,
            data: {profiles: {fresh: {id: 'fresh', username: 'fresh'}}},
        });
    });

    it('skips the profile request entirely when every reader is known', async () => {
        mockedPostReaders.mockResolvedValue({
            readers: [{user_id: 'known', read_at: 1000, exact: true}],
            truncated: true,
        });

        const store = makeStore({known: {username: 'known'}});
        await loadPostReaders(store, 'p1');

        expect(mockedUsers).not.toHaveBeenCalled();
        expect(store.dispatch).toHaveBeenCalledTimes(1);
    });
});
