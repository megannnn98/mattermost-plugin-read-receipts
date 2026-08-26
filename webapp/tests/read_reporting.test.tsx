import React from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';

import ReadReceiptPortals from '../src/components/read_receipt_portals';
import {setStore} from '../src/store_ref';
import {sendReadReceipt} from '../src/actions';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn(),
    reportRead: jest.fn(),
}));

jest.mock('../src/actions', () => ({
    sendReadReceipt: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/visibility', () => ({
    getVisibilityTracker: () => ({
        getState: () => ({isVisible: true, isFocused: true, isIdle: false}),
        isActive: () => true,
        subscribe: () => () => undefined,
    }),
    resetVisibilityTracker: jest.fn(),
}));

type IOEntry = {
    isIntersecting: boolean;
    intersectionRatio: number;
    intersectionRect: {height: number; width: number};
    rootBounds: {height: number; width: number};
};

class MockIntersectionObserver {
    static callbacks: Array<(entries: IOEntry[]) => void> = [];
    static observed: Element[] = [];
    constructor(callback: (entries: IOEntry[]) => void) {
        MockIntersectionObserver.callbacks.push(callback);
    }
    observe(el: Element) {
        MockIntersectionObserver.observed.push(el);
    }
    disconnect() {}
    unobserve() {}
}

const VISIBLE: IOEntry = {
    isIntersecting: true,
    intersectionRatio: 1,
    intersectionRect: {height: 100, width: 500},
    rootBounds: {height: 1000, width: 1920},
};

/**
 * The DOM Mattermost renders: the plugin finds posts by `post_<id>` and observes
 * that element, so a test of the reporting contract has to provide it.
 */
function renderPost(postId: string) {
    const post = document.createElement('div');
    post.id = `post_${postId}`;
    post.className = 'post';
    const body = document.createElement('div');
    body.className = 'post__body';
    post.appendChild(body);
    document.body.appendChild(post);
    return post;
}

function makeStore(posts: Record<string, {id: string; user_id: string; channel_id: string; create_at: number}>) {
    const state: any = {
        entities: {
            users: {currentUserId: 'me', profiles: {}},
            channels: {currentChannelId: 'dm1', channels: {dm1: {id: 'dm1', type: 'D'}}},
            posts: {posts},
        },
        'plugins-com.integrasources.read-receipts': {watermarks: {}, receipts: {}},
    };
    return {getState: () => state, dispatch: jest.fn(), subscribe: jest.fn().mockReturnValue(() => undefined)};
}

const THEIRS = {id: 'theirs', user_id: 'other', channel_id: 'dm1', create_at: 1000};
const MINE = {id: 'mine', user_id: 'me', channel_id: 'dm1', create_at: 2000};

describe('reporting a read', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        jest.useFakeTimers();
        (window as any).IntersectionObserver = MockIntersectionObserver;
        MockIntersectionObserver.callbacks = [];
        MockIntersectionObserver.observed = [];
        (sendReadReceipt as jest.Mock).mockClear();
        (sendReadReceipt as jest.Mock).mockResolvedValue(true);
        document.body.innerHTML = '';
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        setStore(null);
        document.body.innerHTML = '';
        jest.useRealTimers();
    });

    const seeAll = () => MockIntersectionObserver.callbacks.forEach((cb) => cb([VISIBLE]));

    it('reports a read for the other side post that becomes visible', () => {
        // The regression this exists for: mounting components only on own posts
        // left the reporting effect — which runs only on other people's posts —
        // with nowhere to live, and the plugin could not produce a single receipt.
        renderPost(THEIRS.id);
        setStore(makeStore({theirs: THEIRS}) as never);

        act(() => root.render(<ReadReceiptPortals/>));
        seeAll();
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
        expect(sendReadReceipt).toHaveBeenCalledWith('dm1', THEIRS.id, THEIRS.create_at);
    });

    it('observes the post element itself, not something detached from it', () => {
        const post = renderPost(THEIRS.id);
        setStore(makeStore({theirs: THEIRS}) as never);

        act(() => root.render(<ReadReceiptPortals/>));

        expect(MockIntersectionObserver.observed).toContain(post);
    });

    it('never reports a read for a post of our own', () => {
        renderPost(MINE.id);
        setStore(makeStore({mine: MINE}) as never);

        act(() => root.render(<ReadReceiptPortals/>));
        seeAll();
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).not.toHaveBeenCalled();
    });

    it('reports both sides of a conversation independently', () => {
        renderPost(THEIRS.id);
        renderPost(MINE.id);
        setStore(makeStore({theirs: THEIRS, mine: MINE}) as never);

        act(() => root.render(<ReadReceiptPortals/>));
        seeAll();
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
        expect(sendReadReceipt).toHaveBeenCalledWith('dm1', THEIRS.id, THEIRS.create_at);
    });

    it('still attaches when the post element only appears after mounting', () => {
        // The list is virtualised: the element can arrive a tick later. Giving up
        // on the first miss would mean no observer, and nothing re-creates it.
        setStore(makeStore({theirs: THEIRS}) as never);
        act(() => root.render(<ReadReceiptPortals/>));
        expect(MockIntersectionObserver.observed).toHaveLength(0);

        const post = renderPost(THEIRS.id);
        act(() => jest.advanceTimersByTime(500));

        expect(MockIntersectionObserver.observed).toContain(post);

        seeAll();
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledWith('dm1', THEIRS.id, THEIRS.create_at);
    });

    it('gives up on a post element that never appears, leaving no timer behind', () => {
        setStore(makeStore({theirs: THEIRS}) as never);
        act(() => root.render(<ReadReceiptPortals/>));

        act(() => jest.advanceTimersByTime(60000));

        expect(MockIntersectionObserver.observed).toHaveLength(0);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('a message that arrives after the channel is open', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    let listeners: Array<() => void>;
    let state: any;

    beforeEach(() => {
        jest.useFakeTimers();
        (window as any).IntersectionObserver = MockIntersectionObserver;
        MockIntersectionObserver.callbacks = [];
        MockIntersectionObserver.observed = [];
        (sendReadReceipt as jest.Mock).mockClear();
        (sendReadReceipt as jest.Mock).mockResolvedValue(true);
        document.body.innerHTML = '';
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        listeners = [];
        state = {
            entities: {
                users: {currentUserId: 'me', profiles: {}},
                channels: {currentChannelId: 'dm1', channels: {dm1: {id: 'dm1', type: 'D'}}},
                posts: {posts: {}},
            },
            'plugins-com.integrasources.read-receipts': {watermarks: {}, receipts: {}},
        };
        setStore({
            getState: () => state,
            dispatch: jest.fn(),
            subscribe: (listener: () => void) => {
                listeners.push(listener);
                return () => listeners.splice(listeners.indexOf(listener), 1);
            },
        } as never);
    });

    afterEach(() => {
        act(() => root.unmount());
        setStore(null);
        document.body.innerHTML = '';
        jest.useRealTimers();
    });

    it('is picked up and reported without waiting for a scroll', () => {
        // The component used to re-render only on its own retry timers and on
        // scroll/resize, so a message delivered over the websocket a minute after
        // the channel was opened got no observer and was never reported as read.
        act(() => root.render(<ReadReceiptPortals/>));
        act(() => jest.advanceTimersByTime(10000));
        expect(MockIntersectionObserver.observed).toHaveLength(0);

        const arrived = {id: 'arrived', user_id: 'other', channel_id: 'dm1', create_at: 5000};
        const post = renderPost(arrived.id);
        act(() => {
            state = {
                ...state,
                entities: {...state.entities, posts: {posts: {arrived}}},
            };
            listeners.forEach((listener) => listener());
        });

        expect(MockIntersectionObserver.observed).toContain(post);

        MockIntersectionObserver.callbacks.forEach((cb) => cb([VISIBLE]));
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).toHaveBeenCalledWith('dm1', arrived.id, arrived.create_at);
    });

    it('ignores a store notification that changed nothing about posts', () => {
        act(() => root.render(<ReadReceiptPortals/>));
        const before = MockIntersectionObserver.callbacks.length;

        act(() => listeners.forEach((listener) => listener()));

        expect(MockIntersectionObserver.callbacks.length).toBe(before);
    });
});
