import {ReadReceiptsPlugin} from '../src/index';
import {reducer} from '../src/reducer';
import {startChannelWatcher} from '../src/channel_watcher';
import {WS_EVENT} from '../src/websocket';

import * as client from '../src/client';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn().mockResolvedValue({posts: {}, truncated: false}),
    fetchPluginConfig: jest.fn().mockResolvedValue({enabled_channel_types: 'D'}),
    reportRead: jest.fn(),
}));

jest.mock('../src/channel_watcher', () => ({
    startChannelWatcher: jest.fn(),
}));

const mockedConfig = client.fetchPluginConfig as jest.MockedFunction<typeof client.fetchPluginConfig>;
const mockedStartChannelWatcher = startChannelWatcher as jest.MockedFunction<typeof startChannelWatcher>;

function makeRegistry() {
    return {
        registerReducer: jest.fn(),
        registerWebSocketEventHandler: jest.fn(),
        registerPostMessageAttachmentComponent: jest.fn(),
        registerReconnectHandler: jest.fn(),
    };
}

function makeStore() {
    return {
        getState: () => ({entities: {users: {currentUserId: 'me'}, channels: {currentChannelId: ''}, posts: {}}}),
        dispatch: jest.fn(),
        subscribe: jest.fn().mockReturnValue(() => undefined),
    };
}

function makeConfigStore() {
    let pluginState = reducer(undefined, {type: 'INIT'});
    let state: any = {
        entities: {
            users: {currentUserId: 'me'},
            channels: {currentChannelId: 'channel1', channels: {channel1: {id: 'channel1', type: 'G'}}},
            posts: {},
        },
        'plugins-com.integrasources.read-receipts': pluginState,
    };
    const listeners = new Set<() => void>();
    return {
        getState: () => state,
        dispatch: (action: any) => {
            pluginState = reducer(pluginState, action);
            state = {...state, 'plugins-com.integrasources.read-receipts': pluginState};
            listeners.forEach((listener) => listener());
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

describe('plugin entry point', () => {
    afterEach(() => {
        delete (window as any).desktopAPI;
        delete (window as any).registerPlugin;
        jest.resetModules();
    });

    it('registers itself with the webapp through window.registerPlugin', () => {
        const registerPlugin = jest.fn();
        (window as any).registerPlugin = registerPlugin;

        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('../src/index');
        });

        expect(registerPlugin).toHaveBeenCalledTimes(1);
        expect(registerPlugin.mock.calls[0][0]).toBe('com.integrasources.read-receipts');
        const instance = registerPlugin.mock.calls[0][1];
        expect(typeof instance.initialize).toBe('function');
        expect(typeof instance.uninitialize).toBe('function');
    });

    it('registers nothing outside Mattermost Desktop', () => {
        const registry = makeRegistry();
        new ReadReceiptsPlugin().initialize(registry, makeStore());

        expect(registry.registerReducer).not.toHaveBeenCalled();
        expect(registry.registerPostMessageAttachmentComponent).not.toHaveBeenCalled();
        expect(registry.registerWebSocketEventHandler).not.toHaveBeenCalled();
    });

    it('registers reducer, component, websocket handler and reconnect handler on Desktop', () => {
        (window as any).desktopAPI = {getAppInfo: jest.fn().mockResolvedValue({name: 'Mattermost', version: '5.0.0'})};
        const registry = makeRegistry();
        const plugin = new ReadReceiptsPlugin();
        plugin.initialize(registry, makeStore());

        expect(registry.registerReducer).toHaveBeenCalledTimes(1);
        expect(registry.registerPostMessageAttachmentComponent).toHaveBeenCalledTimes(1);
        expect(registry.registerWebSocketEventHandler).toHaveBeenCalledWith(WS_EVENT, expect.any(Function));
        expect(registry.registerReconnectHandler).toHaveBeenCalledWith(expect.any(Function));

        plugin.uninitialize();
    });
    it('loads the plugin configuration at startup and again on reconnect', async () => {
        (window as any).desktopAPI = {getAppInfo: jest.fn().mockResolvedValue({name: 'Mattermost', version: '5.0.0'})};
        const registry = makeRegistry();
        const store = makeStore();
        mockedConfig.mockClear();

        const plugin = new ReadReceiptsPlugin();
        plugin.initialize(registry as never, store as never);
        await Promise.resolve();

        // Nothing is gated on a guess: until this lands the plugin stays inert.
        expect(mockedConfig).toHaveBeenCalledTimes(1);

        // A reconnect is where an administrator's change would otherwise go
        // unnoticed until a full reload.
        registry.registerReconnectHandler.mock.calls[0][0]();
        await Promise.resolve();
        expect(mockedConfig).toHaveBeenCalledTimes(2);

        plugin.uninitialize();
    });

    it('fails closed on reconnect until the fresh configuration resolves', async () => {
        (window as any).desktopAPI = {getAppInfo: jest.fn().mockResolvedValue({name: 'Mattermost', version: '5.0.0'})};
        const registry = makeRegistry();
        const refresh = jest.fn();
        const watcher = {stop: jest.fn(), refresh, refreshSoon: jest.fn(), check: jest.fn()};
        mockedStartChannelWatcher.mockReturnValue(watcher as never);
        mockedConfig.mockResolvedValueOnce({enabled_channel_types: 'DG'});
        const store = makeConfigStore();
        const plugin = new ReadReceiptsPlugin();
        plugin.initialize(registry as never, store as never);
        await Promise.resolve();
        expect(store.getState()['plugins-com.integrasources.read-receipts'].config).toEqual({enabled_channel_types: 'DG'});

        let resolveFresh: (config: {enabled_channel_types: string}) => void = () => undefined;
        mockedConfig.mockImplementationOnce(() => new Promise((resolve) => {
            resolveFresh = resolve;
        }));
        registry.registerReconnectHandler.mock.calls[0][0]();

        // Config is unknown while the request is in flight, so the old G
        // allow-list cannot trigger a query or read report.
        expect(store.getState()['plugins-com.integrasources.read-receipts'].config).toBeNull();
        expect(refresh).not.toHaveBeenCalled();

        resolveFresh({enabled_channel_types: 'D'});
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(store.getState()['plugins-com.integrasources.read-receipts'].config).toEqual({enabled_channel_types: 'D'});
        expect(refresh).toHaveBeenCalledTimes(1);
        plugin.uninitialize();
    });

    it('stays inert when the reconnect configuration request fails', async () => {
        (window as any).desktopAPI = {getAppInfo: jest.fn().mockResolvedValue({name: 'Mattermost', version: '5.0.0'})};
        const registry = makeRegistry();
        const refresh = jest.fn();
        mockedStartChannelWatcher.mockReturnValue({stop: jest.fn(), refresh, refreshSoon: jest.fn(), check: jest.fn()} as never);
        mockedConfig.mockResolvedValueOnce({enabled_channel_types: 'DG'}).mockRejectedValueOnce(new Error('offline'));
        const store = makeConfigStore();
        const plugin = new ReadReceiptsPlugin();
        plugin.initialize(registry as never, store as never);
        await Promise.resolve();

        registry.registerReconnectHandler.mock.calls[0][0]();
        await Promise.resolve();
        await Promise.resolve();
        expect(store.getState()['plugins-com.integrasources.read-receipts'].config).toBeNull();
        expect(refresh).not.toHaveBeenCalled();
        plugin.uninitialize();
    });
});
