import {useCallback, useMemo, useRef, useSyncExternalStore} from 'react';

import {GlobalState, PluginStore} from './types';

const EMPTY_STATE: GlobalState = {};

/**
 * A minimal useSyncExternalStore wrapper that avoids per-component re-render
 * storms: without a cached snapshot, useSyncExternalStore can re-render on
 * every Redux action simply because a selector returned a fresh object. Here
 * getSnapshot only recalculates the selector when the state reference changes,
 * and returns the previous value when the new one is equal (Object.is by
 * default), so root-state-wide updates do not rerender unrelated components.
 */
export function usePluginSelector<T>(
    store: PluginStore | null,
    selector: (state: GlobalState) => T,
    isEqual: (a: T, b: T) => boolean = (a, b) => Object.is(a, b),
): T {
    const cached = useRef<{state: GlobalState; value: T} | null>(null);

    const subscribe = useMemo(
        () => (store ? store.subscribe.bind(store) : () => () => undefined),
        [store],
    );

    const getSnapshot = useCallback((): T => {
        const state = store ? store.getState() : EMPTY_STATE;

        const prev = cached.current;
        if (prev && prev.state === state) {
            return prev.value;
        }

        const next = selector(state);
        if (prev && isEqual(prev.value, next)) {
            cached.current = {state, value: prev.value};
            return prev.value;
        }

        cached.current = {state, value: next};
        return next;
    }, [store, selector, isEqual]);

    return useSyncExternalStore(subscribe, getSnapshot);
}
