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
    static root: Element | Document | null | undefined = undefined;
    constructor(callback: (entries: IOEntry[]) => void, options?: IntersectionObserverInit) {
        MockIntersectionObserver.callback = callback;
        MockIntersectionObserver.threshold = options?.threshold as number[];
        MockIntersectionObserver.root = options?.root;
    }
    observe(el: Element) {
        MockIntersectionObserver.observed.push(el);
    }
    disconnect() {}
    unobserve() {}
}

function entryFor(visible: boolean): IOEntry {
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
                    p2: {id: 'p2', user_id: 'other', channel_id: 'channel1', create_at: 2000},
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

/**
 * The portal approach renders ReadReceipt inside a `.read-receipt-ticks-portal-host`
 * div which lives inside `.post__body` inside a `.post` element. The component's
 * IntersectionObserver targets the `.post` element, so tests must provide that
 * DOM structure.
 */
function makePostDom(postId: string): {post: HTMLDivElement; body: HTMLDivElement; host: HTMLDivElement; container: HTMLDivElement} {
    const post = document.createElement('div');
    post.className = 'post';
    const body = document.createElement('div');
    body.className = 'post__body';
    const host = document.createElement('div');
    host.className = 'read-receipt-ticks-portal-host';
    host.dataset.postId = postId;
    body.appendChild(host);
    post.appendChild(body);
    document.body.appendChild(post);
    return {post, body, host, container: post};
}

describe('ReadReceipt component', () => {
    let root: ReturnType<typeof createRoot>;
    let host: HTMLDivElement;
    let post: HTMLDivElement;

    beforeEach(() => {
        jest.useFakeTimers();
        (window as any).IntersectionObserver = MockIntersectionObserver;
        MockIntersectionObserver.callback = null;
        MockIntersectionObserver.observed = [];
        MockIntersectionObserver.threshold = null;
        MockIntersectionObserver.root = undefined;
        (sendReadReceipt as jest.Mock).mockReset();
        (sendReadReceipt as jest.Mock).mockResolvedValue(true);
        (getVisibilityTracker() as any)._set({isVisible: true, isFocused: true, isIdle: false});
        setStore(makeStore());

        const dom = makePostDom('p1');
        host = dom.host;
        post = dom.post;
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        post.remove();
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

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).not.toHaveBeenCalled();

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
        mSend
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        act(() => root.render(<ReadReceipt postId="p1"/>));

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledTimes(1);

        act(() => jest.advanceTimersByTime(5000));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledTimes(2);

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(mSend).toHaveBeenCalledTimes(2);
    });

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

        current = {
            ...withoutChannel,
            entities: {
                ...withoutChannel.entities,
                channels: {currentChannelId: 'channel1', channels: {channel1: {id: 'channel1', type: 'D'}}},
            },
        };
        act(() => listeners.forEach((cb) => cb()));

        expect(MockIntersectionObserver.observed.length).toBeGreaterThan(0);

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledWith('channel1', 'p1', 1000);
    });

    it('observes against the scrolling post list, not the window', () => {
        // Clean up the beforeEach post so the query finds the test-specific host.
        post.remove();

        const list = document.createElement('div');
        list.style.overflowY = 'auto';
        Object.defineProperty(list, 'scrollHeight', {value: 5000, configurable: true});
        Object.defineProperty(list, 'clientHeight', {value: 492, configurable: true});
        const postEl = document.createElement('div');
        postEl.className = 'post';
        postEl.id = 'post_p1';
        const body = document.createElement('div');
        body.className = 'post__body';
        const hostEl = document.createElement('div');
        hostEl.className = 'read-receipt-ticks-portal-host';
        hostEl.dataset.postId = 'p1';
        body.appendChild(hostEl);
        postEl.appendChild(body);
        list.appendChild(postEl);
        document.body.appendChild(list);

        const localRoot = createRoot(hostEl);
        act(() => localRoot.render(<ReadReceipt postId="p1"/>));

        expect(MockIntersectionObserver.root).toBe(list);
        expect(MockIntersectionObserver.observed[0]).toBe(postEl);

        act(() => localRoot.unmount());
        document.body.removeChild(list);
    });

    it('uses the post list as root before it overflows, and still reports a tall post after it grows', async () => {
        post.remove();

        const list = document.createElement('div');
        list.style.overflowY = 'auto';
        Object.defineProperty(list, 'clientHeight', {value: 492, configurable: true});
        Object.defineProperty(list, 'scrollHeight', {value: 492, configurable: true});
        const postEl = document.createElement('div');
        postEl.className = 'post';
        postEl.id = 'post_p1';
        const body = document.createElement('div');
        body.className = 'post__body';
        const hostEl = document.createElement('div');
        hostEl.className = 'read-receipt-ticks-portal-host';
        hostEl.dataset.postId = 'p1';
        body.appendChild(hostEl);
        postEl.appendChild(body);
        list.appendChild(postEl);
        document.body.appendChild(list);

        const localRoot = createRoot(hostEl);
        act(() => localRoot.render(<ReadReceipt postId="p1"/>));

        expect(MockIntersectionObserver.root).toBe(list);

        Object.defineProperty(list, 'scrollHeight', {value: 6584, configurable: true});

        MockIntersectionObserver.callback?.([{
            isIntersecting: true,
            intersectionRatio: 487 / 8063,
            intersectionRect: {height: 487, width: 500},
            rootBounds: {height: 492, width: 900},
        }]);
        act(() => jest.advanceTimersByTime(1000));
        await flushMicrotasks();

        expect(sendReadReceipt).toHaveBeenCalledWith('channel1', 'p1', 1000);

        act(() => localRoot.unmount());
        document.body.removeChild(list);
    });

    it('aborts a scheduled retry when the window blurs during the backoff', async () => {
        const mSend = sendReadReceipt as jest.Mock;
        mSend.mockResolvedValueOnce(false);

        act(() => root.render(<ReadReceipt postId="p1"/>));

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledTimes(1);

        act(() => (getVisibilityTracker() as any)._set({isFocused: false}));
        act(() => jest.advanceTimersByTime(6000));
        expect(mSend).toHaveBeenCalledTimes(1);
    });

    it('does not let a pending send for one post block the reused component for another', async () => {
        let resolveFirstSend: (ok: boolean) => void = () => undefined;
        const mSend = sendReadReceipt as jest.Mock;
        mSend
            .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                resolveFirstSend = resolve;
            }))
            .mockResolvedValueOnce(true);

        act(() => root.render(<ReadReceipt postId="p1"/>));
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1000));
        expect(mSend).toHaveBeenCalledWith('channel1', 'p1', 1000);

        // Re-render with p2 — need a separate post DOM for p2.
        const dom2 = makePostDom('p2');
        const localRoot2 = createRoot(dom2.host);
        act(() => localRoot2.render(<ReadReceipt postId="p2"/>));
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1000));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledWith('channel1', 'p2', 2000);

        await act(async () => resolveFirstSend(false));
        expect(mSend).toHaveBeenCalledTimes(2);

        act(() => localRoot2.unmount());
        dom2.post.remove();
    });

    it('does not let a sent post block the reused component for another', async () => {
        const mSend = sendReadReceipt as jest.Mock;

        act(() => root.render(<ReadReceipt postId="p1"/>));
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1000));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledWith('channel1', 'p1', 1000);

        const dom2 = makePostDom('p2');
        const localRoot2 = createRoot(dom2.host);
        act(() => localRoot2.render(<ReadReceipt postId="p2"/>));
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1000));
        await flushMicrotasks();
        expect(mSend).toHaveBeenCalledWith('channel1', 'p2', 2000);

        act(() => localRoot2.unmount());
        dom2.post.remove();
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
