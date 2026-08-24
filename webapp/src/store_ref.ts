import {PLUGIN_ID} from './client';

let storeRef: any = null;

export function setStore(store: any): void {
    storeRef = store;
}

export function getStore(): any {
    return storeRef;
}

export function getPluginState(state: any = storeRef?.getState?.()): any {
    if (!state) {
        return {watermarks: {}, receipts: {}, debug: false};
    }
    return state[`plugins-${PLUGIN_ID}`] || {watermarks: {}, receipts: {}, debug: false};
}
