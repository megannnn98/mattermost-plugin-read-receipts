import React, {useEffect} from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';

import {usePluginSelector} from '../src/hooks';
import {GlobalState} from '../src/types';

function makeStore(initial: GlobalState) {
    let state: GlobalState = initial;
    const listeners: Array<() => void> = [];
    return {
        getState: () => state,
        setState: (next: GlobalState) => {
            state = next;
            listeners.slice().forEach((cb) => cb());
        },
        dispatch: jest.fn(),
        subscribe: (cb: () => void) => {
            listeners.push(cb);
            return () => {
                const i = listeners.indexOf(cb);
                if (i >= 0) {
                    listeners.splice(i, 1);
                }
            };
        },
    };
}

describe('usePluginSelector', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    let renders: number;

    const Counter: React.FC<{label: string}> = ({label}) => {
        renders += 1;
        const value = usePluginSelector<string | undefined>(
            (window as any).__store,
            (state) => state?.entities?.users?.currentUserId,
        );
        const count = usePluginSelector<number>(
            (window as any).__store,
            (state) => (state?.entities?.posts?.posts ? Object.keys(state.entities.posts.posts).length : 0),
        );
        // A fresh object on every call — like the component's display selector.
        // Only object-snapshot caching (via isEqual in getSnapshot) prevents a
        // re-render storm for this shape.
        const display = usePluginSelector<{name: string; n: number}>(
            (window as any).__store,
            (state) => ({
                name: state?.entities?.users?.currentUserId ?? '',
                n: state?.entities?.posts?.posts ? Object.keys(state.entities.posts.posts).length : 0,
            }),
            (a, b) => a.name === b.name && a.n === b.n,
        );
        useEffect(() => {
            // silence unused warning for the label param
        }, [label, value, count, display]);
        return <div>{`${label}:${value ?? 'none'}:${count}`}</div>;
    };

    beforeEach(() => {
        renders = 0;
        container = document.createElement('div');
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        (window as any).__store = null;
    });

    it('re-renders only when a subscribed snapshot changes', () => {
        const store = makeStore({
            entities: {
                users: {currentUserId: 'me'},
                posts: {posts: {p1: {id: 'p1', user_id: 'x', channel_id: 'c1', create_at: 1}}},
            },
        });
        (window as any).__store = store;

        act(() => root.render(<Counter label="c"/>));
        expect(renders).toBe(1);

        // 1) A notification with an unchanged state reference -> no re-render.
        act(() => {
            store.getState();
            // setState with a NEW object that is still equal on the subscribed
            // selectors must not re-render either (cached snapshot equality).
            store.setState({
                entities: {
                    users: {currentUserId: 'me'},
                    posts: {posts: {p1: {id: 'p1', user_id: 'x', channel_id: 'c1', create_at: 1}}},
                },
            });
        });
        expect(renders).toBe(1);

        // 2) A change to the selected currentUserId must re-render via the
        //    subscription (no manual render here).
        act(() => {
            store.setState({
                entities: {
                    users: {currentUserId: 'you'},
                    posts: {posts: {p1: {id: 'p1', user_id: 'x', channel_id: 'c1', create_at: 1}}},
                },
            });
        });
        expect(renders).toBe(2);
    });

    it('does not re-render on an irrelevant action that replaces the root state reference', () => {
        const store = makeStore({
            entities: {users: {currentUserId: 'me'}, posts: {posts: {}}},
        });
        (window as any).__store = store;

        act(() => root.render(<Counter label="c"/>));
        expect(renders).toBe(1);

        // A real Redux action replaces the root state with a brand-new reference,
        // but only in an unrelated branch. The subscribed snapshots
        // (currentUserId and the post count) are unchanged, so the Object.is-equal
        // caching in getSnapshot must prevent a re-render.
        act(() => {
            store.setState({
                entities: {
                    channels: {currentChannelId: 'other'},
                    users: {currentUserId: 'me'},
                    posts: {posts: {}},
                },
            });
        });
        expect(renders).toBe(1);
    });
});
