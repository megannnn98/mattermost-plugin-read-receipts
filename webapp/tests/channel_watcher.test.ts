import {collectOwnPostIds, isEligibleChannel, REFRESH_DEBOUNCE_MS, RETRY_BASE_MS, startChannelWatcher} from '../src/channel_watcher';
import {pluginBranch, BRANCH} from './helpers';
import * as actions from '../src/actions';
import {ACTION_TYPES} from '../src/reducer';
import * as client from '../src/client';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn(),
    reportRead: jest.fn(),
}));

const mockedFetch = client.fetchChannelReceipts as jest.MockedFunction<typeof client.fetchChannelReceipts>;

function makeState(enabledChannelTypes: string | null = 'DGPO') {
    return {
        [BRANCH]: pluginBranch({config: enabledChannelTypes === null ? null : {enabled_channel_types: enabledChannelTypes}}),
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
                    p5: {id: 'p5', user_id: 'me', channel_id: 'dm1', create_at: 500, root_id: 'p1'},
                    q1: {id: 'q1', user_id: 'me', channel_id: 'dm2', create_at: 500},
                },
                postsInChannel: {
                    dm1: [{order: ['p1']}, {order: ['p5', 'p4', 'p3', 'p2'], recent: true}],
                    dm2: [{order: ['q1'], recent: true}],
                },
            },
        },
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

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

    it('collects newest posts first when the post list spans multiple blocks', () => {
        const state: any = makeState();
        state.entities.posts.postsInChannel = {
            dm1: [
                {order: ['oldest_own', 'oldest_other']},
                {order: ['mid_own']},
                {order: ['newest_own', 'newest_other'], recent: true},
            ],
        };
        state.entities.posts.posts = {
            ...state.entities.posts.posts,
            oldest_own: {id: 'oldest_own', user_id: 'me', channel_id: 'dm1', create_at: 1},
            oldest_other: {id: 'oldest_other', user_id: 'x', channel_id: 'dm1', create_at: 2},
            mid_own: {id: 'mid_own', user_id: 'me', channel_id: 'dm1', create_at: 3},
            newest_own: {id: 'newest_own', user_id: 'me', channel_id: 'dm1', create_at: 4},
            newest_other: {id: 'newest_other', user_id: 'x', channel_id: 'dm1', create_at: 5},
        };

        expect(collectOwnPostIds(state, 'dm1')).toEqual(['newest_own', 'mid_own', 'oldest_own']);
    });

    it('keeps the newest posts when a multi-block list exceeds the limit', () => {
        const state: any = makeState();
        state.entities.posts.postsInChannel = {
            dm1: [
                {order: ['old_own']},
                {order: ['new_own', 'new_other'], recent: true},
            ],
        };
        state.entities.posts.posts = {
            ...state.entities.posts.posts,
            old_own: {id: 'old_own', user_id: 'me', channel_id: 'dm1', create_at: 1},
            new_own: {id: 'new_own', user_id: 'me', channel_id: 'dm1', create_at: 2},
            new_other: {id: 'new_other', user_id: 'x', channel_id: 'dm1', create_at: 3},
        };

        expect(collectOwnPostIds(state, 'dm1', 1)).toEqual(['new_own']);
    });

    it('respects the limit', () => {
        expect(collectOwnPostIds(makeState(), 'dm1', 1)).toEqual(['p4']);
    });

    // mergePostBlocks returns the untouched array when no merge happened, so the
    // recent block can sit at either end. The result must not depend on that.
    it.each([
        ['recent block last', [{order: ['old_own']}, {order: ['new_own'], recent: true}]],
        ['recent block first', [{order: ['new_own'], recent: true}, {order: ['old_own']}]],
    ])('is independent of the block position (%s)', (_name, blocks) => {
        const state: any = makeState();
        state.entities.posts.postsInChannel = {dm1: blocks};
        state.entities.posts.posts = {
            old_own: {id: 'old_own', user_id: 'me', channel_id: 'dm1', create_at: 1},
            new_own: {id: 'new_own', user_id: 'me', channel_id: 'dm1', create_at: 2},
        };

        expect(collectOwnPostIds(state, 'dm1')).toEqual(['new_own', 'old_own']);
        expect(collectOwnPostIds(state, 'dm1', 1)).toEqual(['new_own']);
    });

    it('is independent of the order inside a block', () => {
        const state: any = makeState();
        state.entities.posts.postsInChannel = {dm1: [{order: ['a_own', 'b_own'], recent: true}]};
        state.entities.posts.posts = {
            a_own: {id: 'a_own', user_id: 'me', channel_id: 'dm1', create_at: 1},
            b_own: {id: 'b_own', user_id: 'me', channel_id: 'dm1', create_at: 2},
        };

        expect(collectOwnPostIds(state, 'dm1')).toEqual(['b_own', 'a_own']);
    });

    it('does not report the same post twice when blocks overlap', () => {
        const state: any = makeState();
        state.entities.posts.postsInChannel = {
            dm1: [{order: ['dup_own']}, {order: ['dup_own'], recent: true}],
        };
        state.entities.posts.posts = {
            dup_own: {id: 'dup_own', user_id: 'me', channel_id: 'dm1', create_at: 7},
        };

        expect(collectOwnPostIds(state, 'dm1')).toEqual(['dup_own']);
    });

    it('returns an empty list when posts are not loaded', () => {
        expect(collectOwnPostIds(makeState(), 'unknown')).toEqual([]);
        expect(collectOwnPostIds({}, 'dm1')).toEqual([]);
    });
});

describe('isEligibleChannel', () => {
    it('returns null while the channel entity is not loaded', () => {
        expect(isEligibleChannel(makeState(), 'missing')).toBeNull();
    });

    it('follows the server configuration rather than a hard-coded list', () => {
        expect(isEligibleChannel(makeState('DGPO'), 'dm1')).toBe(true);
        expect(isEligibleChannel(makeState('DGPO'), 'town')).toBe(true);
        expect(isEligibleChannel(makeState('D'), 'town')).toBe(false);
        expect(isEligibleChannel(makeState('GPO'), 'dm1')).toBe(false);
    });

    it('waits instead of guessing while the configuration is unknown', () => {
        // Null means "not decidable yet". Treating it as enabled would report
        // reads the server is about to refuse; treating it as disabled would mark
        // the channel handled and never load it.
        expect(isEligibleChannel(makeState(null), 'dm1')).toBeNull();
    });

    it('is null for a channel that has not loaded', () => {
        expect(isEligibleChannel(makeState(), 'nope')).toBeNull();
    });
});

describe('startChannelWatcher', () => {
    beforeEach(() => {
        mockedFetch.mockReset();
        mockedFetch.mockResolvedValue({posts: {}, truncated: false});
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

    it('does not lose a channel switch that happens while a query is in flight', async () => {
        // A deferred promise keeps DM A's query pending so we can switch to B
        // while it is mid-flight.
        const state = makeState();
        const store = makeStore(state);
        let resolveA: (v: client.QueryResponse) => void = () => undefined;
        mockedFetch.mockImplementation((channelId: string) => {
            if (channelId === 'dm1') {
                return new Promise((resolve) => {
                    resolveA = (v) => resolve(v);
                });
            }
            return Promise.resolve({watermark: null, receipts: {}});
        });

        const watcher = startChannelWatcher(store);
        await flush();
        // DM A's query is still pending.
        expect(mockedFetch).toHaveBeenCalledWith('dm1', ['p4', 'p1']);
        expect(mockedFetch).toHaveBeenCalledTimes(1);

        // Switch to DM B while A is still in flight; the watcher must not lose it.
        state.entities.channels.currentChannelId = 'dm2';
        store.notify();
        await flush();
        expect(mockedFetch).toHaveBeenCalledTimes(1); // not loaded prematurely

        // Once A's query completes, the watcher must automatically load B.
        resolveA({watermark: null, receipts: {}});
        await flush();
        await flush();

        expect(mockedFetch).toHaveBeenNthCalledWith(2, 'dm2', ['q1']);
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

    it('retries a failed query after backoff and only handles the channel on success', async () => {
        jest.useFakeTimers();
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        mockedFetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({watermark: null, receipts: {}});
        const store = makeStore(makeState());
        const watcher = startChannelWatcher(store);

        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(store.dispatch).not.toHaveBeenCalled();

        jest.advanceTimersByTime(5000);
        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(2);
        expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({type: ACTION_TYPES.RECEIPTS_QUERY}));

        watcher.stop();
        error.mockRestore();
        jest.useRealTimers();
    });

    it('increases failure backoff instead of retrying on every store tick', async () => {
        jest.useFakeTimers();
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        mockedFetch.mockRejectedValue(new Error('offline'));
        const store = makeStore(makeState());
        const watcher = startChannelWatcher(store);

        await flushMicrotasks();
        store.notify();
        store.notify();
        expect(mockedFetch).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(4999);
        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(2);

        jest.advanceTimersByTime(9999);
        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(2);
        watcher.stop();
        error.mockRestore();
        jest.useRealTimers();
    });

    it('refresh() retries immediately instead of sitting out the backoff', async () => {
        jest.useFakeTimers();
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        mockedFetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({watermark: null, receipts: {}});
        const store = makeStore(makeState());
        const watcher = startChannelWatcher(store);

        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(1);

        // A websocket reconnect is exactly the event the backed-off channel was
        // waiting for; it must not wait out the remaining backoff.
        watcher.refresh();
        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(2);
        expect(store.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({type: ACTION_TYPES.RECEIPTS_QUERY}),
        );

        watcher.stop();
        error.mockRestore();
        jest.useRealTimers();
    });

    it('survives a loader that rejects instead of resolving false', async () => {
        jest.useFakeTimers();
        const loader = jest.spyOn(actions, 'loadChannelReceipts');
        loader.mockRejectedValueOnce(new Error('boom'));
        mockedFetch.mockResolvedValue({posts: {}, truncated: false});
        const store = makeStore(makeState());
        const watcher = startChannelWatcher(store);

        await flushMicrotasks();
        expect(loader).toHaveBeenCalledTimes(1);

        // A dropped rejection would leave inFlightChannelId set and wedge the
        // watcher forever: the backoff retry proves it is still alive.
        loader.mockRestore();
        jest.advanceTimersByTime(RETRY_BASE_MS);
        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(store.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({type: ACTION_TYPES.RECEIPTS_QUERY}),
        );

        watcher.stop();
        jest.useRealTimers();
    });

    it('stop() cancels a scheduled failed-query retry', async () => {
        jest.useFakeTimers();
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        mockedFetch.mockRejectedValue(new Error('offline'));
        const watcher = startChannelWatcher(makeStore(makeState()));

        await flushMicrotasks();
        watcher.stop();
        jest.advanceTimersByTime(60000);
        await flushMicrotasks();
        expect(mockedFetch).toHaveBeenCalledTimes(1);

        error.mockRestore();
        jest.useRealTimers();
    });
});

describe('channel eligibility drives the watcher', () => {
    beforeEach(() => {
        mockedFetch.mockReset();
        mockedFetch.mockResolvedValue({posts: {}, truncated: false});
    });

    function watcherOn(state: ReturnType<typeof makeState>) {
        const listeners: Array<() => void> = [];
        const store = {
            getState: () => state,
            dispatch: jest.fn(),
            subscribe: (listener: () => void) => {
                listeners.push(listener);
                return () => listeners.splice(listeners.indexOf(listener), 1);
            },
        };
        return {watcher: startChannelWatcher(store as never), store, notify: () => listeners.forEach((l) => l())};
    }

    it('does not query a channel type the administrator disabled', async () => {
        const state = makeState('G');
        const {watcher} = watcherOn(state);
        await flush();

        expect(mockedFetch).not.toHaveBeenCalled();
        watcher.stop();
    });

    it('does not query anything before the configuration has arrived', async () => {
        const {watcher} = watcherOn(makeState(null));
        await flush();

        expect(mockedFetch).not.toHaveBeenCalled();
        watcher.stop();
    });

    it('never asks about thread replies', async () => {
        const {watcher} = watcherOn(makeState());
        await flush();

        expect(mockedFetch).toHaveBeenCalledTimes(1);
        const [, postIds] = mockedFetch.mock.calls[0];
        // p5 is a reply; asking about it would put a reply's read into the
        // channel watermark and mark every older channel message read.
        expect(postIds).not.toContain('p5');
        expect(postIds).toContain('p4');
        watcher.stop();
    });

    it('coalesces a burst of websocket receipts into one re-query', async () => {
        jest.useFakeTimers();
        const {watcher} = watcherOn(makeState());
        await Promise.resolve();
        await Promise.resolve();
        mockedFetch.mockClear();

        watcher.refreshSoon();
        watcher.refreshSoon();
        watcher.refreshSoon();
        expect(mockedFetch).not.toHaveBeenCalled();

        jest.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
        expect(mockedFetch).toHaveBeenCalledTimes(1);

        watcher.stop();
        jest.useRealTimers();
    });

    it('stop() cancels a pending coalesced re-query', async () => {
        jest.useFakeTimers();
        const {watcher} = watcherOn(makeState());
        await Promise.resolve();
        await Promise.resolve();
        mockedFetch.mockClear();

        watcher.refreshSoon();
        watcher.stop();
        jest.advanceTimersByTime(REFRESH_DEBOUNCE_MS * 2);

        expect(mockedFetch).not.toHaveBeenCalled();
        jest.useRealTimers();
    });
});
