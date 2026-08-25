import {PluginStore} from './types';

let storeRef: PluginStore | null = null;

export function setStore(store: PluginStore | null): void {
    storeRef = store;
}

export function getStore(): PluginStore | null {
    return storeRef;
}
