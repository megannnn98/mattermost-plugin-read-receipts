import {ReadReceiptsPlugin} from '../src/index';
import {WS_EVENT} from '../src/websocket';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn().mockResolvedValue({watermark: null, receipts: {}, debug: false}),
    reportRead: jest.fn(),
}));

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
});
