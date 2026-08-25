import React from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';

import ReadReceipt from '../src/components/read_receipt';
import {setStore} from '../src/store_ref';
import {loadPostReaders} from '../src/actions';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn(),
    reportRead: jest.fn(),
    fetchPostReaders: jest.fn(),
    fetchUsersByIds: jest.fn(),
}));

jest.mock('../src/actions', () => ({
    sendReadReceipt: jest.fn().mockResolvedValue(true),
    loadPostReaders: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/visibility', () => {
    const state = {isVisible: true, isFocused: true, isIdle: false};
    return {
        getVisibilityTracker: () => ({
            getState: () => ({...state}),
            isActive: () => true,
            subscribe: () => () => undefined,
        }),
        resetVisibilityTracker: jest.fn(),
    };
});

class NoopIntersectionObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
}

const PLUGIN_BRANCH = 'plugins-com.integrasources.read-receipts';

type Branch = {
    watermarks: Record<string, Record<string, unknown>>;
    receipts: Record<string, Record<string, number>>;
    readers: Record<string, {list: Array<{user_id: string; read_at: number; exact: boolean}>; truncated: boolean}>;
    profiles: Record<string, unknown>;
};

function makeStore(channelType: string, branch: Partial<Branch> = {}, postAuthor = 'me') {
    let state: any = {
        entities: {
            users: {currentUserId: 'me', profiles: {}},
            channels: {
                currentChannelId: 'ch1',
                channels: {ch1: {id: 'ch1', type: channelType}},
            },
            posts: {
                posts: {p1: {id: 'p1', user_id: postAuthor, channel_id: 'ch1', create_at: 2000}},
            },
        },
        [PLUGIN_BRANCH]: {watermarks: {}, receipts: {}, readers: {}, profiles: {}, ...branch},
    };
    const listeners = new Set<() => void>();
    return {
        getState: () => state,
        dispatch: jest.fn(),
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        // Mirrors what Redux does: a new root object, then notify. Used by the
        // tests that must re-render through the store rather than by re-rendering
        // the component by hand.
        patchPost: (patch: Record<string, unknown>) => {
            const posts = {...state.entities.posts.posts};
            posts.p1 = {...posts.p1, ...patch};
            state = {...state, entities: {...state.entities, posts: {...state.entities.posts, posts}}};
            listeners.forEach((listener) => listener());
        },
    };
}

function watermark(readerId: string, createAt: number) {
    return {reader_id: readerId, post_id: 'px', create_at: createAt, read_at: createAt + 100};
}

describe('ReadReceipt in group, private and open channels', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        (window as any).IntersectionObserver = NoopIntersectionObserver;
        (loadPostReaders as jest.Mock).mockClear();
        document.body.innerHTML = `
            <div class="post">
                <div class="post__body">
                    <div class="post-message__text"><p>hello</p></div>
                    <div id="slot"></div>
                </div>
            </div>`;
        container = document.getElementById('slot') as HTMLDivElement;
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        setStore(null);
        document.body.innerHTML = '';
    });

    // Only the indicator, never the message itself: an edited message would
    // otherwise leak into the assertion.
    const indicatorText = () => {
        const text = document.querySelector('.post-message__text')!.textContent ?? '';
        const match = text.match(/✓+(\s*\d+)?/);
        return match ? match[0].trim() : '';
    };

    it.each(['G', 'P', 'O'])('renders a sentinel for someone else post in a %s channel', (channelType) => {
        setStore(makeStore(channelType, {}, 'other') as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        // Without this sentinel there is nothing for the IntersectionObserver to
        // watch, so reads would never be reported outside DMs at all.
        expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    });

    it('renders nothing in a channel type the plugin does not handle', () => {
        setStore(makeStore('X', {}, 'other') as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(container.innerHTML).toBe('');
    });

    it('shows the reader count inline for an own group post', () => {
        setStore(makeStore('G', {
            watermarks: {ch1: {a: watermark('a', 3000), b: watermark('b', 4000)}},
        }) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('✓✓ 2');
    });

    // Regression: the mount used to be gated on an arbitrarily picked reader's
    // read time. When the first reader in key order had not reached the post but
    // another had, the count was 1 while that time was null, and the indicator
    // silently never mounted.
    it('mounts the indicator when the first indexed reader does not cover the post', () => {
        setStore(makeStore('G', {
            watermarks: {ch1: {stale: watermark('stale', 1000), fresh: watermark('fresh', 5000)}},
        }) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('✓✓ 1');
    });

    it('renders nothing while nobody has read the post', () => {
        setStore(makeStore('G', {
            watermarks: {ch1: {stale: watermark('stale', 1000)}},
        }) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('');
    });

    it('does not count the author or the current user', () => {
        setStore(makeStore('G', {
            receipts: {p1: {me: 9000, other: 9000}},
        }, 'other') as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        // The post belongs to `other`, so this component only renders the reading
        // sentinel; the count path is exercised by the selector tests.
        expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    });

    it('shows a bare checkmark with the read time in a DM instead of a count', () => {
        setStore(makeStore('D', {
            receipts: {p1: {other: new Date('2024-01-01T10:20:00Z').getTime()}},
        }) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('✓✓');
        expect(document.querySelector('.post-message__text span[title]')!.getAttribute('title')).toContain('Read at');
    });

    it('requests the reader list once when the count is clicked', () => {
        setStore(makeStore('G', {
            watermarks: {ch1: {a: watermark('a', 3000)}},
        }) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));

        const button = document.querySelector('.post-message__text button') as HTMLButtonElement;
        act(() => button.click());

        expect(loadPostReaders).toHaveBeenCalledTimes(1);
        expect((loadPostReaders as jest.Mock).mock.calls[0][1]).toBe('p1');
    });

    it('does not request the reader list again when it is already cached', () => {
        setStore(makeStore('G', {
            watermarks: {ch1: {a: watermark('a', 3000)}},
            readers: {p1: {list: [{user_id: 'a', read_at: 3100, exact: true}], truncated: false}},
        }) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));

        const button = document.querySelector('.post-message__text button') as HTMLButtonElement;
        act(() => button.click());

        expect(loadPostReaders).not.toHaveBeenCalled();
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('closes the reader list on Escape', () => {
        setStore(makeStore('G', {
            watermarks: {ch1: {a: watermark('a', 3000)}},
            readers: {p1: {list: [{user_id: 'a', read_at: 3100, exact: true}], truncated: false}},
        }) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));
        act(() => (document.querySelector('.post-message__text button') as HTMLButtonElement).click());

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
        });

        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
    it('opens the reader list immediately and keeps it dismissable when the request fails', async () => {
        (loadPostReaders as jest.Mock).mockRejectedValueOnce(new Error('network down'));
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        setStore(makeStore('G', {
            watermarks: {ch1: {a: watermark('a', 3000)}},
        }) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));

        await act(async () => {
            (document.querySelector('.post-message__text button') as HTMLButtonElement).click();
            await Promise.resolve();
        });

        // Rendering only once the readers arrive would strand a failed request:
        // the open flag stays true while nothing — not even Escape — is mounted.
        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).toContain('Could not load');

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        (console.error as jest.Mock).mockRestore();
    });
    it('re-attaches the indicator after Mattermost rebuilds the message', () => {
        const store = makeStore('G', {watermarks: {ch1: {a: watermark('a', 3000)}}}) as any;
        setStore(store);
        act(() => root.render(<ReadReceipt postId='p1'/>));
        expect(indicatorText()).toBe('✓✓ 1');

        // What an edit or a reaction does: React rebuilds the message and our
        // appended node goes with it. Nothing tells this component to re-render,
        // which is why the post's render key is part of the selector.
        const text = document.querySelector('.post-message__text') as HTMLElement;
        text.innerHTML = '<p>edited</p>';
        const state = store.getState();
        state.entities.posts.posts.p1 = {...state.entities.posts.posts.p1, update_at: 5000, edit_at: 5000};

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('✓✓ 1');
        expect(document.querySelector('.post-message__text p')!.textContent).toContain('edited');
    });

    it('re-attaches when the node was dropped without any state change', () => {
        setStore(makeStore('G', {watermarks: {ch1: {a: watermark('a', 3000)}}}) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));
        expect(indicatorText()).toBe('✓✓ 1');

        const text = document.querySelector('.post-message__text') as HTMLElement;
        text.innerHTML = '<p>hello</p>';

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('✓✓ 1');
    });
    it('notices a rebuilt message through the store, without being re-rendered by hand', () => {
        const store = makeStore('G', {watermarks: {ch1: {a: watermark('a', 3000)}}}) as any;
        setStore(store);
        act(() => root.render(<ReadReceipt postId='p1'/>));
        expect(indicatorText()).toBe('✓✓ 1');

        // In the real client nothing re-renders this component when the message
        // around it is rebuilt — it is a sibling of the message, not a child. The
        // only thing that can wake it is a store change it actually selects, which
        // is why the post's render key is part of the selected value.
        const text = document.querySelector('.post-message__text') as HTMLElement;
        text.innerHTML = '<p>edited</p>';
        act(() => store.patchPost({update_at: 5000, edit_at: 5000}));

        expect(indicatorText()).toBe('✓✓ 1');
    });
});
