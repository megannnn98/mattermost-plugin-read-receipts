import React from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';

import ReadReceipt from '../src/components/read_receipt';
import {setStore} from '../src/store_ref';
import {getVisibilityTracker} from '../src/visibility';
import {sendReadReceipt} from '../src/actions';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn(),
    reportRead: jest.fn(),
}));

jest.mock('../src/actions', () => ({
    sendReadReceipt: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/visibility', () => {
    const state = {isVisible: true, isFocused: true, isIdle: false};
    const listeners: Set<(s: typeof state) => void> = new Set();
    return {
        getVisibilityTracker: () => ({
            getState: () => ({...state}),
            isActive: () => state.isVisible && state.isFocused && !state.isIdle,
            subscribe: (cb: (s: typeof state) => void) => {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
            _set: (partial: Partial<typeof state>) => {
                Object.assign(state, partial);
                listeners.forEach((cb) => cb({...state}));
            },
        }),
        resetVisibilityTracker: jest.fn(),
    };
});

type IOEntry = {
    isIntersecting: boolean;
    intersectionRatio: number;
    intersectionRect: {height: number; width: number};
    rootBounds: {height: number; width: number};
};

class MockIntersectionObserver {
    static callback: ((entries: IOEntry[]) => void) | null = null;
    static observed: Element[] = [];
    static threshold: number[] | null = null;
    constructor(callback: (entries: IOEntry[]) => void, options?: IntersectionObserverInit) {
        MockIntersectionObserver.callback = callback;
        MockIntersectionObserver.threshold = options?.threshold as number[];
    }
    observe(el: Element) {
        MockIntersectionObserver.observed.push(el);
    }
    disconnect() {}
    unobserve() {}
}

function entryFor(visible: boolean): IOEntry {
    // A visible post: 100% of its area in a 1000px viewport.
    return visible
        ? {
            isIntersecting: true,
            intersectionRatio: 1,
            intersectionRect: {height: 100, width: 500},
            rootBounds: {height: 1000, width: 1920},
        }
        : {
            isIntersecting: false,
            intersectionRatio: 0,
            intersectionRect: {height: 0, width: 0},
            rootBounds: {height: 1000, width: 1920},
        };
}

function makeState() {
    return {
        entities: {
            users: {currentUserId: 'me'},
            channels: {
                currentChannelId: 'channel1',
                channels: {channel1: {id: 'channel1', type: 'D'}},
            },
            posts: {
                posts: {
                    p1: {id: 'p1', user_id: 'other', channel_id: 'channel1', create_at: 1000},
                },
            },
        },
    };
}

function makeStore() {
    const state = makeState();
    return {
        getState: () => state,
        dispatch: jest.fn(),
        subscribe: jest.fn().mockReturnValue(() => undefined),
    };
}

function fireIntersecting(visible: boolean) {
    MockIntersectionObserver.callback?.([entryFor(visible)]);
}

const flushMicrotasks = () => act(async () => {
    await Promise.resolve();
    await Promise.resolve();
});

describe('ReadReceipt component', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        jest.useFakeTimers();
        (window as any).IntersectionObserver = MockIntersectionObserver;
        MockIntersectionObserver.callback = null;
        MockIntersectionObserver.observed = [];
        MockIntersectionObserver.threshold = null;
        (sendReadReceipt as jest.Mock).mockReset();
        (sendReadReceipt as jest.Mock).mockResolvedValue(true);
        (getVisibilityTracker() as any)._set({isVisible: true, isFocused: true, isIdle: false});
        setStore(makeStore());
        container = document.createElement('div');
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        setStore(null);
        jest.useRealTimers();
    });

    it('reports a read after the dwell when the window is active and the post visible', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
        expect(sendReadReceipt).toHaveBeenCalledWith('channel1', 'p1', 1000);
    });

    it('does not report while the window is not focused', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));
        (getVisibilityTracker() as any)._set({isFocused: false});

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).not.toHaveBeenCalled();
    });

    it('starts the dwell again when focus returns while the post is still visible', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));
        (getVisibilityTracker() as any)._set({isFocused: false});

        // The post enters the viewport while the window is unfocused.
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).not.toHaveBeenCalled();

        // Focus returns with the post already visible: no new IntersectionObserver
        // callback fires, so the tracker state change must restart the dwell.
        act(() => (getVisibilityTracker() as any)._set({isFocused: true}));
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
        expect(sendReadReceipt).toHaveBeenCalledWith('channel1', 'p1', 1000);
    });

    it('does not double-report after focus regain', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));
        (getVisibilityTracker() as any)._set({isFocused: false});

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        act(() => (getVisibilityTracker() as any)._set({isFocused: true}));
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledTimes(1);

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
    });

    it('does not report a post that is below the visibility threshold', () => {
        const below = {isIntersecting: true, intersectionRatio: 0.5, intersectionRect: {height: 50, width: 500}, rootBounds: {height: 1000, width: 1920}};
        act(() => root.render(<ReadReceipt postId="p1"/>));

        MockIntersectionObserver.callback?.([below]);
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).not.toHaveBeenCalled();
    });

    it('reports via the tall-post fallback when its visible slice fills the viewport', () => {
        // A post taller than the viewport: low ratio (0.1) but its in-view slice
        // (height 900) exceeds 75% of the 1000px viewport height.
        const tall = {isIntersecting: true, intersectionRatio: 0.1, intersectionRect: {height: 900, width: 500}, rootBounds: {height: 1000, width: 1920}};
        act(() => root.render(<ReadReceipt postId="p1"/>));

        MockIntersectionObserver.callback?.([tall]);
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
    });

    it('observes tall-post threshold progression until the fallback becomes visible', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));

        const thresholds = MockIntersectionObserver.threshold;
        expect(thresholds).not.toBeNull();
        expect(thresholds).toEqual(expect.arrayContaining([0, 0.001, 0.0075, 0.01, 1]));
        expect(thresholds!.some((threshold) => threshold <= 0.75 * 1000 / 50000)).toBe(true);

        MockIntersectionObserver.callback?.([{
            isIntersecting: true,
            intersectionRatio: 0.02,
            intersectionRect: {height: 100, width: 500},
            rootBounds: {height: 1000, width: 1920},
        }]);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).not.toHaveBeenCalled();

        MockIntersectionObserver.callback?.([{
            isIntersecting: true,
            intersectionRatio: 0.16,
            intersectionRect: {height: 800, width: 500},
            rootBounds: {height: 1000, width: 1920},
        }]);
        act(() => jest.advanceTimersByTime(1000));
        expect(sendReadReceipt).toHaveBeenCalledWith('channel1', 'p1', 1000);
    });

    it('cancels the send when the post leaves the viewport during the dwell', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(500));
        fireIntersecting(false);
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).not.toHaveBeenCalled();
    });

    it('retries after a failed request, then never sends again once it succeeds', async () => {
        const mSend = sendReadReceipt as jest.Mock;
        // The real sendReadReceipt returns false on failure (it never rejects),
        // so model a failure as an explicit false result.
        mSend
            .mockResolvedValueOnce(false)  // first attempt fails
            .mockResolvedValueOnce(true);                      // retry succeeds

        act(() => root.render(<ReadReceipt postId="p1"/>));

        // First attempt: failure during the initial dwell.
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledTimes(1);

        // After the backoff the request is retried and succeeds.
        act(() => jest.advanceTimersByTime(5000));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledTimes(2);

        // The post stays visible: no further sends.
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(mSend).toHaveBeenCalledTimes(2);
    });

    // The channel entity can land in the store after the post component has
    // already mounted (a cold channel switch). While it is missing the component
    // renders nothing, so there is no sentinel to observe; the effect must run
    // again once the channel becomes known, otherwise the post is never tracked
    // and its read receipt is never sent.
    it('attaches the observer when the channel entity arrives after mount', () => {
        const listeners: Array<() => void> = [];
        const withoutChannel: any = {
            entities: {
                users: {currentUserId: 'me'},
                channels: {currentChannelId: 'channel1', channels: {}},
                posts: {posts: {p1: {id: 'p1', user_id: 'other', channel_id: 'channel1', create_at: 1000}}},
            },
        };
        let current = withoutChannel;
        setStore({
            getState: () => current,
            dispatch: jest.fn(),
            subscribe: (cb: () => void) => {
                listeners.push(cb);
                return () => undefined;
            },
        } as any);

        act(() => root.render(<ReadReceipt postId="p1"/>));
        expect(MockIntersectionObserver.observed).toHaveLength(0);

        // The channel entity arrives; Redux notifies with a fresh state object.
        current = {
            ...withoutChannel,
            entities: {
                ...withoutChannel.entities,
                channels: {currentChannelId: 'channel1', channels: {channel1: {id: 'channel1', type: 'D'}}},
            },
        };
        act(() => listeners.forEach((cb) => cb()));

        expect(container.querySelectorAll('span')).toHaveLength(1);
        expect(MockIntersectionObserver.observed.length).toBeGreaterThan(0);

        // And the post is now actually tracked end to end.
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledWith('channel1', 'p1', 1000);
    });

    it('aborts a scheduled retry when the window blurs during the backoff', async () => {
        const mSend = sendReadReceipt as jest.Mock;
        mSend.mockResolvedValueOnce(false);

        act(() => root.render(<ReadReceipt postId="p1"/>));

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledTimes(1);

        // Blur during the retry backoff cancels the pending retry.
        act(() => (getVisibilityTracker() as any)._set({isFocused: false}));
        act(() => jest.advanceTimersByTime(6000));
        expect(mSend).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])('ignores a pending send result after unmount (%s)', async (result) => {
        let resolveSend: (ok: boolean) => void = () => undefined;
        (sendReadReceipt as jest.Mock).mockReset().mockImplementationOnce(() => new Promise((resolve) => {
            resolveSend = resolve;
        }));

        act(() => root.render(<ReadReceipt postId="p1"/>));
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledTimes(1);

        act(() => root.unmount());
        await act(async () => resolveSend(result));
        expect(jest.getTimerCount()).toBe(0);
        act(() => jest.advanceTimersByTime(60000));
        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
    });
});
