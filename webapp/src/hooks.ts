import {useEffect, useReducer, useRef} from 'react';

import {GlobalState, PluginStore} from './types';

const EMPTY_STATE: GlobalState = {};

/**
 * A React 16.8-compatible external-store selector (Mattermost 9.5 ships React
 * 17, which has no useSyncExternalStore).
 *
 * The selector runs during render, so a prop it closes over (postId) takes
 * effect in the very same render. On a store notification the cached
 * root-state reference is used to skip the selector entirely: combineReducers
 * hands back the same root when no slice changed, and an unchanged root cannot
 * change the selected value. A re-render happens only when the selected value
 * itself changed under `isEqual`, so an unrelated Redux action does not
 * re-render the post.
 */
export function usePluginSelector<T>(
    store: PluginStore | null,
    selector: (state: GlobalState) => T,
    isEqual: (a: T, b: T) => boolean = (a, b) => Object.is(a, b),
): T {
    const cached = useRef<{state: GlobalState; value: T} | null>(null);
    const selectorRef = useRef(selector);
    const isEqualRef = useRef(isEqual);
    const [, forceRender] = useReducer((count: number) => count + 1, 0);

    selectorRef.current = selector;
    isEqualRef.current = isEqual;

    const getSnapshot = (): T => {
        const state = store ? store.getState() : EMPTY_STATE;
        const prev = cached.current;
        const next = selectorRef.current(state);
        if (prev && isEqualRef.current(prev.value, next)) {
            cached.current = {state, value: prev.value};
            return prev.value;
        }

        cached.current = {state, value: next};
        return next;
    };

    const value = getSnapshot();

    useEffect(() => {
        if (!store) {
            return undefined;
        }

        const check = () => {
            const prev = cached.current;
            if (prev && prev.state === store.getState()) {
                return;
            }
            const next = getSnapshot();
            if (!prev || !isEqualRef.current(prev.value, next)) {
                forceRender();
            }
        };

        const unsubscribe = store.subscribe(check);
        // Do not lose an update that lands between render and subscription.
        check();
        return unsubscribe;
    }, [store]);

    return value;
}
