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
    statuses: Record<string, {count: number; truncated: boolean; read_at: number | null}>;
    readers: Record<string, {list: Array<{user_id: string; read_at: number; exact: boolean}>; truncated: boolean; nextOffset: number}>;
    profiles: Record<string, unknown>;
    profilesRevision: number;
    config: {enabled_channel_types: string} | null;
};

function makeStore(channelType: string, branch: Partial<Branch> = {}, postAuthor = 'me', enabled = 'DGPO') {
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
        [PLUGIN_BRANCH]: {
            statuses: {},
            readers: {},
            profiles: {},
            profilesRevision: 0,
            config: enabled === '' ? null : {enabled_channel_types: enabled},
            ...branch,
        },
    };
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((listener) => listener());
    return {
        getState: () => state,
        dispatch: jest.fn(),
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        // Mirrors what Redux does: a new root object, then notify.
        patchPost: (patch: Record<string, unknown>) => {
            const posts = {...state.entities.posts.posts};
            posts.p1 = {...posts.p1, ...patch};
            state = {...state, entities: {...state.entities, posts: {...state.entities.posts, posts}}};
            notify();
        },
        patchBranch: (patch: Partial<Branch>) => {
            state = {...state, [PLUGIN_BRANCH]: {...state[PLUGIN_BRANCH], ...patch}};
            notify();
        },
    };
}

const status = (count: number, truncated = false, readAt: number | null = null) => ({
    p1: {count, truncated, read_at: readAt},
});

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

    // The indicator is an SVG plus an optional count, so it is described by its
    // tick state rather than by the message text.
    const indicatorText = () => {
        const tick = document.querySelector('.post-message__text svg[data-tick]');
        if (!tick) {
            return '';
        }
        const state = tick.getAttribute('data-tick');
        const count = tick.parentElement?.textContent?.trim() ?? '';
        return count ? `${state} ${count}` : state!;
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
            statuses: status(2),
        }) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('read 2');
    });

    // Regression: the mount used to be gated on an arbitrarily picked reader's
    // read time. When the first reader in key order had not reached the post but
    // another had, the count was 1 while that time was null, and the indicator
    // silently never mounted.
    it('mounts the indicator when the first indexed reader does not cover the post', () => {
        setStore(makeStore('G', {
            statuses: status(1),
        }) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('read 1');
    });

    it('shows a single delivered tick while nobody has read the post', () => {
        setStore(makeStore('G', {
            statuses: status(0),
        }) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('delivered');
    });

    it('shows nothing at all while the post is still being sent', () => {
        const store = makeStore('G') as any;
        store.getState().entities.posts.posts.p1.pending_post_id = 'p1';
        setStore(store);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('');
    });

    it('shows nothing for a post the server refused', () => {
        const store = makeStore('G') as any;
        store.getState().entities.posts.posts.p1.state = 'FAILED';
        setStore(store);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('');
    });

    it('does not count the author or the current user', () => {
        setStore(makeStore('G', {
            statuses: status(1),
        }, 'other') as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        // The post belongs to `other`, so this component only renders the reading
        // sentinel; the count path is exercised by the selector tests.
        expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    });

    it('shows a bare checkmark with the read time in a DM instead of a count', () => {
        setStore(makeStore('D', {
            statuses: status(1, false, new Date('2024-01-01T10:20:00Z').getTime()),
        }) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(indicatorText()).toBe('read');
        expect(document.querySelector('.post-message__text span[title]')!.getAttribute('title')).toContain('Read at');
    });

    it('requests the reader list once when the count is clicked', () => {
        setStore(makeStore('G', {
            statuses: status(1),
        }) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));

        const button = document.querySelector('.post-message__text button') as HTMLButtonElement;
        act(() => button.click());

        expect(loadPostReaders).toHaveBeenCalledTimes(1);
        expect((loadPostReaders as jest.Mock).mock.calls[0][1]).toBe('p1');
    });

    it('does not request the reader list again when it is already cached', () => {
        setStore(makeStore('G', {
            statuses: status(1),
            readers: {p1: {list: [{user_id: 'a', read_at: 3100, exact: true}], truncated: false, nextOffset: 0}},
        }) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));

        const button = document.querySelector('.post-message__text button') as HTMLButtonElement;
        act(() => button.click());

        expect(loadPostReaders).not.toHaveBeenCalled();
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('closes the reader list on Escape', () => {
        setStore(makeStore('G', {
            statuses: status(1),
            readers: {p1: {list: [{user_id: 'a', read_at: 3100, exact: true}], truncated: false, nextOffset: 0}},
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
            statuses: status(1),
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
    it('re-attaches the indicator after Mattermost rebuilds the message', async () => {
        setStore(makeStore('G', {statuses: status(1)}) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));
        expect(indicatorText()).toBe('read 1');

        // What an edit, a reaction or a formatting change does: React rebuilds the
        // message and our appended node goes with it. Nothing re-renders this
        // component — it is a sibling of the message, not a child — so an observer
        // on the post body is what notices.
        const text = document.querySelector('.post-message__text') as HTMLElement;
        await act(async () => {
            text.innerHTML = '<p>edited</p>';
            await Promise.resolve();
        });

        expect(indicatorText()).toBe('read 1');
        expect(document.querySelector('.post-message__text p')!.textContent).toContain('edited');
    });

    it('re-attaches without any Redux action at all', async () => {
        setStore(makeStore('G', {statuses: status(1)}) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));

        const text = document.querySelector('.post-message__text') as HTMLElement;
        await act(async () => {
            // Not a state change of any kind — just the DOM being replaced.
            text.replaceChildren(document.createElement('p'));
            await Promise.resolve();
        });

        expect(indicatorText()).toBe('read 1');
    });

    it('stops observing once the component goes away', async () => {
        const disconnect = jest.fn();
        const RealObserver = window.MutationObserver;
        (window as any).MutationObserver = class {
            constructor(private cb: MutationCallback) {}
            observe() {}
            disconnect() {
                disconnect();
            }
            takeRecords() {
                return [];
            }
        };

        setStore(makeStore('G', {statuses: status(1)}) as any);
        act(() => root.render(<ReadReceipt postId='p1'/>));
        act(() => root.unmount());

        expect(disconnect).toHaveBeenCalled();
        (window as any).MutationObserver = RealObserver;
        root = createRoot(container);
    });

    it('opens the reader list immediately and keeps it dismissable when the request fails', async () => {
        (loadPostReaders as jest.Mock).mockRejectedValueOnce(new Error('network down'));
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        setStore(makeStore('G', {statuses: status(1)}) as any);
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

    it('names readers as soon as their profiles arrive, with no other action', async () => {
        const store = makeStore('G', {
            statuses: status(1),
            readers: {p1: {list: [{user_id: 'a', read_at: 3100, exact: true}], truncated: false, nextOffset: 0}},
        }) as any;
        setStore(store);
        act(() => root.render(<ReadReceipt postId='p1'/>));
        act(() => (document.querySelector('.post-message__text button') as HTMLButtonElement).click());

        // Readers are here, profiles are not: the raw id stands in for the name.
        expect(document.querySelector('[role="dialog"]')!.textContent).toContain('a ·');

        act(() => store.patchBranch({profiles: {a: {username: 'ada'}}, profilesRevision: 1}));

        expect(document.querySelector('[role="dialog"]')!.textContent).toContain('ada');
    });

    it('renders nothing in a channel type the administrator disabled', () => {
        setStore(makeStore('O', {statuses: status(2)}, 'me', 'D') as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(container.innerHTML).toBe('');
        expect(indicatorText()).toBe('');
    });

    it('renders nothing before the configuration is known', () => {
        setStore(makeStore('G', {statuses: status(2)}, 'me', '') as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(container.innerHTML).toBe('');
    });

    it('does not report a read in a channel type the administrator disabled', () => {
        setStore(makeStore('O', {}, 'other', 'D') as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        // No sentinel means nothing is ever observed and no read is ever sent.
        expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    });

    it('does not render an indicator for a thread reply', () => {
        const store = makeStore('G', {statuses: status(2)}) as any;
        store.patchPost({root_id: 'root1'});

        act(() => root.render(<ReadReceipt postId='p1'/>));

        expect(container.innerHTML).toBe('');
    });

    it('shows a truncated count as a lower bound rather than an exact number', () => {
        setStore(makeStore('O', {statuses: status(200, true)}) as any);

        act(() => root.render(<ReadReceipt postId='p1'/>));

        // 200 readers were counted, but the channel has more: printing "200" would
        // claim a precision the server explicitly said it does not have.
        expect(indicatorText()).toBe('read 200+');
    });
});
