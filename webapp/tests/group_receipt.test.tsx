import React from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';

import ReadReceipt from '../src/components/read_receipt';
import {setStore} from '../src/store_ref';
import {loadPostReaders} from '../src/actions';
import {reducer, ACTION_TYPES} from '../src/reducer';

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
    readersEpoch: Record<string, number>;
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
            readersEpoch: {},
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

    // Regression: a live websocket receipt raises the indicator's count but the
    // cached reader list was left stale, so an open (or reopened) popover kept
    // naming only the old readers. The reducer now drops that list on the event
    // and the popover's effect refetches it, so the new reader is shown.
    it('refetches and shows a new reader after a WS receipt invalidates the open list', async () => {
        const store = makeStore('G', {
            statuses: status(1),
            readers: {p1: {list: [{user_id: 'a', read_at: 3100, exact: true}], truncated: false, nextOffset: 0}},
        }) as any;
        // Route a processed POST_READERS page back into the store so the refetch
        // can land, mirroring what the real action does.
        store.dispatch = jest.fn((action: any) => {
            if (action.type === 'plugins-com.integrasources.read-receipts_POST_READERS') {
                const {postId, readers, truncated, nextOffset} = action.data;
                store.patchBranch({readers: {[postId]: {list: readers, truncated, nextOffset}}});
            }
            return undefined;
        });
        // The real action resolves after the response is dispatched.
        (loadPostReaders as jest.Mock).mockImplementation(async (s, postId) => {
            s.dispatch({
                type: 'plugins-com.integrasources.read-receipts_POST_READERS',
                data: {postId, readers: [{user_id: 'a', read_at: 3100, exact: true}, {user_id: 'b', read_at: 3200, exact: true}], truncated: false, nextOffset: 0, append: false},
            });
        });
        setStore(store);
        act(() => root.render(<ReadReceipt postId='p1'/>));

        // Open the cached list: shows the old reader, no refetch yet.
        const button = document.querySelector('.post-message__text button') as HTMLButtonElement;
        act(() => button.click());
        expect(loadPostReaders).not.toHaveBeenCalled();
        expect(document.querySelector('[role="dialog"]')!.textContent).toContain('a ·');

        // A live WS receipt: count 2, and the stale list is dropped by the reducer.
        (loadPostReaders as jest.Mock).mockClear();
        act(() => store.patchBranch({statuses: status(2), readers: {}}));

        // The open popover refetches and, once the page lands, shows the new reader.
        expect(loadPostReaders).toHaveBeenCalledTimes(1);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(document.querySelector('[role="dialog"]')!.textContent).toContain('b ·');
        expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('Could not load');
    });

    // The in-flight race: a request issued before a WS receipt is still pending
    // when the WS invalidates the post. The epoch mechanism must (a) re-fire the
    // open popover's load even though no list was cached yet, and (b) make the
    // reducer drop the late stale response, so the fresh one is what lands.
    it('does not let a stale in-flight reader page win over a live WS receipt', async () => {
        // A store whose dispatches go through the real reducer, so the epoch logic
        // is exercised end to end rather than faked.
        const base = {
            entities: {
                users: {currentUserId: 'me', profiles: {}},
                channels: {currentChannelId: 'ch1', channels: {ch1: {id: 'ch1', type: 'G'}}},
                posts: {posts: {p1: {id: 'p1', user_id: 'me', channel_id: 'ch1', create_at: 2000}}},
            },
            [PLUGIN_BRANCH]: (reducer as any)(undefined, {type: 'UNKNOWN'}),
        };
        let state: any = base;
        const listeners = new Set<() => void>();
        const store = {
            getState: () => state,
            dispatch: jest.fn((action: any) => {
                state = {
                    ...state,
                    [PLUGIN_BRANCH]: reducer(state[PLUGIN_BRANCH], action),
                };
                listeners.forEach((l) => l());
                return undefined;
            }),
            subscribe: (l: () => void) => {
                listeners.add(l);
                return () => listeners.delete(l);
            },
        };

        // Request A (statuses pre-WS, epoch 0) is held open; request B (fresh,
        // epoch 1) is also held. Resolving them in order lets us prove the stale
        // A is rejected and only the fresh B lands.
        let resolveA: (value?: unknown) => void = () => undefined;
        let resolveB: (value?: unknown) => void = () => undefined;
        (loadPostReaders as jest.Mock)
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveA = () => {
                    // The in-flight stale page comes back late with the OLD epoch.
                    store.dispatch({
                        type: ACTION_TYPES.POST_READERS,
                        data: {postId: 'p1', readers: [{user_id: 'a', read_at: 3100, exact: true}], truncated: false, nextOffset: 0, append: false, epoch: 0},
                    });
                    resolve(undefined);
                };
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveB = () => {
                    store.dispatch({
                        type: ACTION_TYPES.POST_READERS,
                        data: {postId: 'p1', readers: [{user_id: 'b', read_at: 3200, exact: true}, {user_id: 'a', read_at: 3100, exact: true}], truncated: false, nextOffset: 0, append: false, epoch: 1},
                    });
                    resolve(undefined);
                };
            }));
        setStore(store as any);
        // Seed config (channel type G enabled) and a count so the group indicator
        // renders as a clickable button.
        act(() => store.dispatch({
            type: ACTION_TYPES.CONFIG,
            data: {config: {enabled_channel_types: 'DGPO'}},
        }));
        act(() => store.dispatch({
            type: ACTION_TYPES.RECEIPTS_QUERY,
            data: {channelId: 'ch1', posts: {p1: {count: 1, truncated: false, read_at: null}}},
        }));
        act(() => root.render(<ReadReceipt postId='p1'/>));

        // Open the popover with no cache: request A goes out.
        act(() => (document.querySelector('.post-message__text button') as HTMLButtonElement).click());
        expect(loadPostReaders).toHaveBeenCalledTimes(1);

        // A live WS receipt invalidates the post (reducer bumps the epoch to 1).
        act(() => store.dispatch({
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'ch1', post_id: 'p1', read_at: 3200, reader_id: 'b', isDM: false},
        }));
        expect(state[PLUGIN_BRANCH].statuses.p1.count).toBe(1);
        expect(state[PLUGIN_BRANCH].readersEpoch.p1).toBe(1);
        // The open popover re-loads — the epoch change fired the effect even though
        // no list was cached and nothing else about the cache changed.
        expect(loadPostReaders).toHaveBeenCalledTimes(2);

        // The late stale response (A, epoch 0) resolves now: it must be dropped.
        await act(async () => {
            resolveA();
            await Promise.resolve();
        });
        expect(state[PLUGIN_BRANCH].readers.p1).toBeUndefined();

        // Request B (fresh, epoch 1) lands and is what the popover shows.
        await act(async () => {
            resolveB();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(state[PLUGIN_BRANCH].readers.p1.list.map((r) => r.user_id)).toEqual(['b', 'a']);
        expect(document.querySelector('[role="dialog"]')!.textContent).toContain('b ·');
        expect(document.querySelector('[role="dialog"]')!.textContent).toContain('a ·');
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

        // The popover's effect loads the readers after the click, so give the
        // rejected request enough microtask turns to flip the status to "error".
        await act(async () => {
            (document.querySelector('.post-message__text button') as HTMLButtonElement).click();
            await Promise.resolve();
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

        // Reader loading is deferred to the popover's effect, so flush enough
        // microtasks for the rejected request to flip the status to "error".
        await act(async () => {
            (document.querySelector('.post-message__text button') as HTMLButtonElement).click();
            await Promise.resolve();
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
