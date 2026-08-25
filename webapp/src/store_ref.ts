import {PLUGIN_ID} from './client';
import {GlobalState, PluginState, PluginStore} from './types';

let storeRef: PluginStore | null = null;

export function setStore(store: PluginStore | null): void {
    storeRef = store;
}

export function getStore(): PluginStore | null {
    return storeRef;
}

export function getPluginState(state?: GlobalState): PluginState {
    if (!state) {
        return {watermarks: {}, receipts: {}, debug: false};
    }
    return (state[`plugins-${PLUGIN_ID}`] as PluginState | undefined) || {watermarks: {}, receipts: {}, debug: false};
}
