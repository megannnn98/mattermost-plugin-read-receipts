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
    static disconnectCount = 0;
    private callback: (entries: IOEntry[]) => void;
    constructor(callback: (entries: IOEntry[]) => void) {
        this.callback = callback;
        MockIntersectionObserver.callbacks.push(callback);
    }
    observe(el: Element) {
        MockIntersectionObserver.observed.push(el);
    }
    disconnect() {
        MockIntersectionObserver.disconnectCount++;
        const idx = MockIntersectionObserver.callbacks.indexOf(this.callback);
        if (idx >= 0) {
            MockIntersectionObserver.callbacks.splice(idx, 1);
        }
    }
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
        MockIntersectionObserver.disconnectCount = 0;
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
        MockIntersectionObserver.disconnectCount = 0;
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

    // --- Five new regression tests covering the review findings ---

    // #1: own/incoming split. Mutating collectDmPostIds to return only own
    // posts would make this fail — incoming posts would never mount, so no
    // observer would be created and no receipt reported.
    it('mounts observers for incoming posts, not only for own posts', () => {
        renderPost(THEIRS.id);
        renderPost(MINE.id);
        setStore(makeStore({theirs: THEIRS, mine: MINE}) as never);

        act(() => root.render(<ReadReceiptPortals/>));

        // Incoming post gets an observer (for reporting).
        const theirPost = document.getElementById(`post_${THEIRS.id}`);
        expect(MockIntersectionObserver.observed).toContain(theirPost);

        // Own post gets a portal host (for rendering the tick), not an observer
        // here — the ReadReceipt component renders the tick from state, not
        // from visibility. Its effect exits early on isOwn.
        const host = document.querySelector(`.read-receipt-ticks-portal-host[data-post-id="${MINE.id}"]`);
        expect(host).not.toBeNull();
    });

    // #3: unmount during attach retry must not leave timers behind and must
    // not call setState on an unmounted component.
    it('cleans up the attach-retry timer when the component unmounts mid-retry', () => {
        // No DOM element for the post — the component will enter the retry path.
        setStore(makeStore({theirs: THEIRS}) as never);
        act(() => root.render(<ReadReceiptPortals/>));
        expect(MockIntersectionObserver.observed).toHaveLength(0);

        // Schedule is: 100, 300, 1000, 3000 ms. Unmount before the first fires.
        act(() => root.unmount());
        act(() => jest.advanceTimersByTime(10000));

        expect(jest.getTimerCount()).toBe(0);
        expect(MockIntersectionObserver.observed).toHaveLength(0);
    });

    // #4: when a post leaves the store, its component unmounts and the observer
    // is disconnected — no hanging observers for posts the user no longer sees.
    it('disconnects the observer when the component unmounts', () => {
        const post = renderPost(THEIRS.id);
        setStore(makeStore({theirs: THEIRS}) as never);

        act(() => root.render(<ReadReceiptPortals/>));
        expect(MockIntersectionObserver.observed).toContain(post);
        expect(MockIntersectionObserver.callbacks.length).toBe(1);

        // Explicit unmount — the component tree tears down and every
        // ReadReceipt effect cleanup runs, which disconnects its observer.
        act(() => root.unmount());

        expect(MockIntersectionObserver.callbacks.length).toBe(0);

        // And no receipt is produced for the removed post even if visibility
        // is signalled manually.
        MockIntersectionObserver.callbacks.forEach((cb) => cb([VISIBLE]));
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).not.toHaveBeenCalled();
    });
});

// Separate describe so the large store does not leak into the other tests.
describe('cost of the portal post-id collection', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        jest.useFakeTimers();
        (window as any).IntersectionObserver = MockIntersectionObserver;
        MockIntersectionObserver.callbacks = [];
        MockIntersectionObserver.observed = [];
        MockIntersectionObserver.disconnectCount = 0;
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

    // #5: the cached collectDmPostIds must not walk the posts map on a noop
    // notification. Proxy the posts object to count ownKeys calls — Object.values
    // hits ownKeys once per call, so any re-render after the cache is warm would
    // bump the counter.
    it('does not walk the posts map on a noop notification once the cache is warm', () => {
        const rawPosts: Record<string, {id: string; user_id: string; channel_id: string; create_at: number}> = {};
        for (let i = 0; i < 1000; i++) {
            rawPosts[`p${i}`] = {
                id: `p${i}`,
                user_id: i % 2 === 0 ? 'me' : 'other',
                channel_id: 'dm1',
                create_at: i,
            };
        }
        const rawChannels = {dm1: {id: 'dm1', type: 'D'}};

        let ownKeysCalls = 0;
        const posts = new Proxy(rawPosts, {
            ownKeys(target) {
                ownKeysCalls++;
                return Reflect.ownKeys(target);
            },
            getOwnPropertyDescriptor(target, prop) {
                return Object.getOwnPropertyDescriptor(target, prop);
            },
        });
        const channels = new Proxy(rawChannels, {
            ownKeys(target) {
                ownKeysCalls++;
                return Reflect.ownKeys(target);
            },
            getOwnPropertyDescriptor(target, prop) {
                return Object.getOwnPropertyDescriptor(target, prop);
            },
        });

        const listeners: Array<() => void> = [];
        const state: any = {
            entities: {
                users: {currentUserId: 'me', profiles: {}},
                channels: {currentChannelId: 'dm1', channels: rawChannels},
                posts: {posts},
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

        // First render warms the cache — ownKeys fires for posts and channels.
        act(() => root.render(<ReadReceiptPortals/>));
        const afterWarmup = ownKeysCalls;
        expect(afterWarmup).toBeGreaterThan(0);

        // Ten noop notifications: identity check fires, but the cached lists
        // are returned without another ownKeys traversal.
        for (let i = 0; i < 10; i++) {
            act(() => listeners.forEach((listener) => listener()));
        }
        expect(ownKeysCalls).toBe(afterWarmup);
    });
});

// Tests covering the review findings: channel scoping, late DOM, null user,
// and multi-DM resource boundedness.
describe('channel scoping and late DOM', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        jest.useFakeTimers();
        (window as any).IntersectionObserver = MockIntersectionObserver;
        MockIntersectionObserver.callbacks = [];
        MockIntersectionObserver.observed = [];
        MockIntersectionObserver.disconnectCount = 0;
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

    // HIGH-1 / MEDIUM-1: only posts in the current DM get observers.
    // Incoming posts in other DMs must not mount (no observers, no timers).
    it('mounts observers only for posts in the current DM, not for other DMs', () => {
        const listeners: Array<() => void> = [];
        const state: any = {
            entities: {
                users: {currentUserId: 'me', profiles: {}},
                channels: {
                    currentChannelId: 'dm1',
                    channels: {
                        dm1: {id: 'dm1', type: 'D'},
                        dm2: {id: 'dm2', type: 'D'},
                    },
                },
                posts: {
                    posts: {
                        theirs: {id: 'theirs', user_id: 'other', channel_id: 'dm1', create_at: 1000},
                        theirsInDm2: {id: 'theirsInDm2', user_id: 'other', channel_id: 'dm2', create_at: 2000},
                    },
                },
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

        renderPost('theirs');
        renderPost('theirsInDm2');

        act(() => root.render(<ReadReceiptPortals/>));

        // Observer only for the post in the current channel.
        const theirPost = document.getElementById('post_theirs');
        const theirsInDm2Post = document.getElementById('post_theirsInDm2');
        expect(MockIntersectionObserver.observed).toContain(theirPost);
        expect(MockIntersectionObserver.observed).not.toContain(theirsInDm2Post);
    });

    // HIGH-1: channel switch away drops observers, switch back recreates them.
    it('recreates the observer when the user switches back to the channel', () => {
        const listeners: Array<() => void> = [];
        const state: any = {
            entities: {
                users: {currentUserId: 'me', profiles: {}},
                channels: {
                    currentChannelId: 'dm1',
                    channels: {
                        dm1: {id: 'dm1', type: 'D'},
                        dm2: {id: 'dm2', type: 'D'},
                    },
                },
                posts: {
                    posts: {
                        theirs: {id: 'theirs', user_id: 'other', channel_id: 'dm1', create_at: 1000},
                    },
                },
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

        renderPost('theirs');
        act(() => root.render(<ReadReceiptPortals/>));
        expect(MockIntersectionObserver.observed).toContain(document.getElementById('post_theirs'));
        MockIntersectionObserver.callbacks.length = 0;

        // Switch away — observer disconnects, no callbacks remain.
        act(() => {
            state.entities.channels = {
                ...state.entities.channels,
                currentChannelId: 'dm2',
            };
            listeners.forEach((l) => l());
        });
        expect(MockIntersectionObserver.callbacks.length).toBe(0);

        // Wipe the observed list so the next assertion proves the observer was
        // freshly created on switch-back, not just surviving from before.
        MockIntersectionObserver.observed.length = 0;

        // Switch back — fresh observer on the same (reused) DOM element.
        act(() => {
            state.entities.channels = {
                ...state.entities.channels,
                currentChannelId: 'dm1',
            };
            listeners.forEach((l) => l());
        });
        // Flush React's batched store-subscription update.
        act(() => {});
        // The observer must be re-created for the post in the current channel.
        expect(MockIntersectionObserver.observed).toContain(document.getElementById('post_theirs'));
        expect(MockIntersectionObserver.callbacks.length).toBe(1);

        // And a receipt is produced for the post.
        MockIntersectionObserver.callbacks.forEach((cb) => cb([VISIBLE]));
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledWith('dm1', 'theirs', 1000);
    });

    // HIGH-1: post element appears after the attach-retry window.
    // The portal key flips from '...-0' to '...-1' when the element appears,
    // remounting ReadReceipt which then finds the element on the first try.
    it('recreates the component when the post element appears after retries', () => {
        const listeners: Array<() => void> = [];
        const state: any = {
            entities: {
                users: {currentUserId: 'me', profiles: {}},
                channels: {currentChannelId: 'dm1', channels: {dm1: {id: 'dm1', type: 'D'}}},
                posts: {posts: {theirs: {id: 'theirs', user_id: 'other', channel_id: 'dm1', create_at: 1000}}},
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

        // Render without the post element — attach retry starts.
        act(() => root.render(<ReadReceiptPortals/>));
        expect(MockIntersectionObserver.observed).toHaveLength(0);

        // Exhaust all retries (100 + 300 + 1000 + 3000 = 4400ms).
        act(() => jest.advanceTimersByTime(5000));
        expect(jest.getTimerCount()).toBe(0);
        expect(MockIntersectionObserver.observed).toHaveLength(0);

        // Now the element appears and a store notification flips the key.
        renderPost('theirs');
        act(() => {
            // Force cache invalidation by mutating the posts reference.
            state.entities.posts.posts = {...state.entities.posts.posts};
            listeners.forEach((l) => l());
        });

        // A fresh component mounts with the element present — observer attached.
        expect(MockIntersectionObserver.observed).toContain(document.getElementById('post_theirs'));

        MockIntersectionObserver.callbacks.forEach((cb) => cb([VISIBLE]));
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledWith('dm1', 'theirs', 1000);
    });

    // LOW-1: no user id yet — nothing mounts, no observers, no receipts.
    it('mounts nothing when the current user id is not yet known', () => {
        const state: any = {
            entities: {
                users: {currentUserId: undefined, profiles: {}},
                channels: {currentChannelId: 'dm1', channels: {dm1: {id: 'dm1', type: 'D'}}},
                posts: {posts: {theirs: {id: 'theirs', user_id: 'other', channel_id: 'dm1', create_at: 1000}}},
            },
            'plugins-com.integrasources.read-receipts': {watermarks: {}, receipts: {}},
        };
        setStore({
            getState: () => state,
            dispatch: jest.fn(),
            subscribe: jest.fn().mockReturnValue(() => undefined),
        } as never);

        renderPost('theirs');
        act(() => root.render(<ReadReceiptPortals/>));

        expect(MockIntersectionObserver.observed).toHaveLength(0);

        MockIntersectionObserver.callbacks.forEach((cb) => cb([VISIBLE]));
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).not.toHaveBeenCalled();
    });

    // MEDIUM from review: late-DOM appearance via scroll (no store notification)
    // must remount the incoming component and create the observer. Tests the
    // real order: scroll fires first (capture phase), then the virtualised
    // list renders the post, then rAF re-checks presence.
    it('recreates the observer when a late post appears from scroll, without a store notification', () => {
        const listeners: Array<() => void> = [];
        const state: any = {
            entities: {
                users: {currentUserId: 'me', profiles: {}},
                channels: {currentChannelId: 'dm1', channels: {dm1: {id: 'dm1', type: 'D'}}},
                posts: {posts: {theirs: {id: 'theirs', user_id: 'other', channel_id: 'dm1', create_at: 1000}}},
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

        // Mock rAF to run synchronously inside act(), since jest fake timers
        // do not advance rAF callbacks automatically.
        const realRaf = window.requestAnimationFrame;
        let rafCallback: FrameRequestCallback | null = null;
        (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
            rafCallback = cb;
            return 1;
        };
        (window as any).cancelAnimationFrame = () => { rafCallback = null; };

        try {
            // Render without the post element — attach retry starts and exhausts.
            act(() => root.render(<ReadReceiptPortals/>));
            expect(MockIntersectionObserver.observed).toHaveLength(0);

            act(() => jest.advanceTimersByTime(5000));
            expect(jest.getTimerCount()).toBe(0);
            expect(MockIntersectionObserver.observed).toHaveLength(0);

            // Real order: scroll fires (capture phase) BEFORE the list renders.
            act(() => {
                window.dispatchEvent(new Event('scroll'));
            });

            // rAF callback is pending — element still absent, no observer yet.
            expect(MockIntersectionObserver.observed).toHaveLength(0);

            // Now the list renders the post (simulating the bubble-phase scroll
            // handler of the virtualised list).
            renderPost('theirs');

            // Fire the pending rAF — presence re-check sees the new element.
            act(() => {
                if (rafCallback) {
                    rafCallback(0);
                    rafCallback = null;
                }
            });

            // The portal key flips, fresh component mounts, observer attaches.
            expect(MockIntersectionObserver.observed).toContain(document.getElementById('post_theirs'));
            expect(MockIntersectionObserver.callbacks.length).toBe(1);

            MockIntersectionObserver.callbacks.forEach((cb) => cb([VISIBLE]));
            act(() => jest.advanceTimersByTime(1500));
            expect(sendReadReceipt).toHaveBeenCalledWith('dm1', 'theirs', 1000);
        } finally {
            (window as any).requestAnimationFrame = realRaf;
            (window as any).cancelAnimationFrame = realRaf;
        }
    });
});
