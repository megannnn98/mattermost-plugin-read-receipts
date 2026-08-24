import {collectOwnPostIds, isDirectChannel, startChannelWatcher} from '../src/channel_watcher';
import {ACTION_TYPES} from '../src/reducer';
import * as client from '../src/client';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn(),
    reportRead: jest.fn(),
}));

const mockedFetch = client.fetchChannelReceipts as jest.MockedFunction<typeof client.fetchChannelReceipts>;

function makeState() {
    return {
        entities: {
            users: {currentUserId: 'me'},
            channels: {
                currentChannelId: 'dm1',
                channels: {
                    dm1: {id: 'dm1', type: 'D'},
                    dm2: {id: 'dm2', type: 'D'},
                    town: {id: 'town', type: 'O'},
                },
            },
            posts: {
                posts: {
                    p1: {id: 'p1', user_id: 'me', channel_id: 'dm1', create_at: 100},
                    p2: {id: 'p2', user_id: 'other', channel_id: 'dm1', create_at: 200},
                    p3: {id: 'p3', user_id: 'me', channel_id: 'dm1', create_at: 300, delete_at: 301},
                    p4: {id: 'p4', user_id: 'me', channel_id: 'dm1', create_at: 400},
                    q1: {id: 'q1', user_id: 'me', channel_id: 'dm2', create_at: 500},
                },
                postsInChannel: {
                    dm1: [{order: ['p4', 'p3', 'p2'], recent: true}, {order: ['p1']}],
                    dm2: [{order: ['q1'], recent: true}],
                },
            },
        },
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeStore(state: any) {
    const listeners: Array<() => void> = [];
    return {
        getState: () => state,
        dispatch: jest.fn(),
        subscribe: (cb: () => void) => {
            listeners.push(cb);
            return () => {
                const idx = listeners.indexOf(cb);
                if (idx >= 0) {
                    listeners.splice(idx, 1);
                }
            };
        },
        notify: () => listeners.slice().forEach((cb) => cb()),
        listenerCount: () => listeners.length,
    };
}

describe('collectOwnPostIds', () => {
    it('collects only own, non-deleted posts, newest block first', () => {
        expect(collectOwnPostIds(makeState(), 'dm1')).toEqual(['p4', 'p1']);
    });

    it('respects the limit', () => {
        expect(collectOwnPostIds(makeState(), 'dm1', 1)).toEqual(['p4']);
    });

    it('returns an empty list when posts are not loaded', () => {
        expect(collectOwnPostIds(makeState(), 'unknown')).toEqual([]);
        expect(collectOwnPostIds({}, 'dm1')).toEqual([]);
    });
});

describe('isDirectChannel', () => {
    it('returns null while the channel entity is not loaded', () => {
        expect(isDirectChannel(makeState(), 'missing')).toBeNull();
    });

    it('detects DM and non-DM channels', () => {
        expect(isDirectChannel(makeState(), 'dm1')).toBe(true);
        expect(isDirectChannel(makeState(), 'town')).toBe(false);
    });
});

describe('startChannelWatcher', () => {
    beforeEach(() => {
        mockedFetch.mockReset();
        mockedFetch.mockResolvedValue({watermark: null, receipts: {}, debug: false});
    });

    it('loads receipts for the DM that is open at startup', async () => {
        const store = makeStore(makeState());
        const watcher = startChannelWatcher(store);
        await flush();

        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(mockedFetch).toHaveBeenCalledWith('dm1', ['p4', 'p1']);
        expect(store.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({type: ACTION_TYPES.RECEIPTS_QUERY}),
        );
        watcher.stop();
    });

    it('loads once per channel, not on every store update', async () => {
        const store = makeStore(makeState());
        const watcher = startChannelWatcher(store);
        await flush();
        store.notify();
        store.notify();
        await flush();

        expect(mockedFetch).toHaveBeenCalledTimes(1);
        watcher.stop();
    });

    it('loads again after the channel is switched', async () => {
        const state = makeState();
        const store = makeStore(state);
        const watcher = startChannelWatcher(store);
        await flush();

        state.entities.channels.currentChannelId = 'dm2';
        store.notify();
        await flush();

        expect(mockedFetch).toHaveBeenNthCalledWith(2, 'dm2', ['q1']);
        watcher.stop();
    });

    it('skips non-DM channels', async () => {
        const state = makeState();
        state.entities.channels.currentChannelId = 'town';
        const store = makeStore(state);
        const watcher = startChannelWatcher(store);
        await flush();

        expect(mockedFetch).not.toHaveBeenCalled();
        watcher.stop();
    });

    it('waits for posts to arrive before loading', async () => {
        const state: any = makeState();
        state.entities.posts.postsInChannel = {};
        const store = makeStore(state);
        const watcher = startChannelWatcher(store);
        await flush();
        expect(mockedFetch).not.toHaveBeenCalled();

        state.entities.posts.postsInChannel = {dm1: [{order: ['p4'], recent: true}]};
        store.notify();
        await flush();

        expect(mockedFetch).toHaveBeenCalledWith('dm1', ['p4']);
        watcher.stop();
    });

    it('refresh() reloads the current channel (used on websocket reconnect)', async () => {
        const store = makeStore(makeState());
        const watcher = startChannelWatcher(store);
        await flush();
        expect(mockedFetch).toHaveBeenCalledTimes(1);

        watcher.refresh();
        await flush();

        expect(mockedFetch).toHaveBeenCalledTimes(2);
        watcher.stop();
    });

    it('stop() unsubscribes from the store', async () => {
        const store = makeStore(makeState());
        const watcher = startChannelWatcher(store);
        await flush();
        expect(store.listenerCount()).toBe(1);

        watcher.stop();
        expect(store.listenerCount()).toBe(0);
    });
});
