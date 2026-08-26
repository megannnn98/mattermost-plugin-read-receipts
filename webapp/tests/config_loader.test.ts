import {
    CONFIG_MAX_ATTEMPTS,
    CONFIG_RETRY_BASE_MS,
    CONFIG_RETRY_MAX_MS,
    startConfigLoader,
} from '../src/config_loader';
import {loadPluginConfig} from '../src/actions';

jest.mock('../src/client', () => ({PLUGIN_ID: 'com.integrasources.read-receipts'}));
jest.mock('../src/actions', () => ({loadPluginConfig: jest.fn()}));

const mockedLoad = loadPluginConfig as jest.MockedFunction<typeof loadPluginConfig>;
const store = {getState: jest.fn(), dispatch: jest.fn(), subscribe: jest.fn()} as never;

// The loader awaits the request between timer ticks, so a bare timer advance is
// not enough: the promise continuation has to run before the next tick exists.
const settle = async () => {
    for (let i = 0; i < 4; i++) {
        await Promise.resolve();
    }
};
const tick = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    await settle();
};

describe('startConfigLoader', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockedLoad.mockReset();
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        (console.error as jest.Mock).mockRestore();
        jest.useRealTimers();
    });

    it('loads once and schedules nothing when the first attempt succeeds', async () => {
        mockedLoad.mockResolvedValue(true);

        const loader = startConfigLoader(store);
        await settle();

        expect(mockedLoad).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
        loader.stop();
    });

    it('recovers from a failed first attempt without waiting for a reconnect', async () => {
        // The measured failure: the plugin initializes while the session is still
        // being established and the configuration endpoint answers 401. Before
        // the retry this left the plugin inert — no indicators, no read reports —
        // for the rest of the session.
        mockedLoad.mockResolvedValueOnce(false).mockResolvedValue(true);

        const loader = startConfigLoader(store);
        await settle();
        expect(mockedLoad).toHaveBeenCalledTimes(1);

        await tick(CONFIG_RETRY_BASE_MS);

        expect(mockedLoad).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
        expect(console.error).not.toHaveBeenCalled();
        loader.stop();
    });

    it('backs off between attempts instead of hammering the endpoint', async () => {
        mockedLoad.mockResolvedValue(false);

        const loader = startConfigLoader(store);
        await settle();

        await tick(CONFIG_RETRY_BASE_MS - 1);
        expect(mockedLoad).toHaveBeenCalledTimes(1);
        await tick(1);
        expect(mockedLoad).toHaveBeenCalledTimes(2);

        // Second wait is longer than the first.
        await tick(CONFIG_RETRY_BASE_MS);
        expect(mockedLoad).toHaveBeenCalledTimes(2);
        await tick(CONFIG_RETRY_BASE_MS);
        expect(mockedLoad).toHaveBeenCalledTimes(3);

        loader.stop();
    });

    it('gives up after a bounded number of attempts and leaves no timer behind', async () => {
        mockedLoad.mockResolvedValue(false);

        const loader = startConfigLoader(store);
        await settle();
        for (let i = 0; i < CONFIG_MAX_ATTEMPTS; i++) {
            await tick(CONFIG_RETRY_MAX_MS);
        }

        expect(mockedLoad).toHaveBeenCalledTimes(CONFIG_MAX_ATTEMPTS);
        expect(jest.getTimerCount()).toBe(0);
        expect(console.error).toHaveBeenCalledTimes(1);
        loader.stop();
    });

    it('starts over on reload, which is what a reconnect calls', async () => {
        mockedLoad.mockResolvedValue(false);
        const loader = startConfigLoader(store);
        await settle();
        for (let i = 0; i < CONFIG_MAX_ATTEMPTS; i++) {
            await tick(CONFIG_RETRY_MAX_MS);
        }
        expect(jest.getTimerCount()).toBe(0);

        mockedLoad.mockResolvedValue(true);
        await expect(loader.reload()).resolves.toBe(true);

        expect(mockedLoad).toHaveBeenCalledTimes(CONFIG_MAX_ATTEMPTS + 1);
        loader.stop();
    });

    it('reload after a give-up gets the whole retry sequence again, not one last try', async () => {
        mockedLoad.mockResolvedValue(false);
        const loader = startConfigLoader(store);
        await settle();
        for (let i = 0; i < CONFIG_MAX_ATTEMPTS; i++) {
            await tick(CONFIG_RETRY_MAX_MS);
        }
        const afterGiveUp = mockedLoad.mock.calls.length;

        // Still failing. Carrying the old attempt count over would make this
        // single request the give-up as well, so a reconnect would buy nothing.
        await loader.reload();
        expect(jest.getTimerCount()).toBe(1);

        await tick(CONFIG_RETRY_BASE_MS);
        expect(mockedLoad).toHaveBeenCalledTimes(afterGiveUp + 2);
        loader.stop();
    });

    it('stop() cancels a scheduled retry and ignores a request already in flight', async () => {
        let resolveLoad: (value: boolean) => void = () => undefined;
        mockedLoad.mockImplementation(() => new Promise<boolean>((resolve) => {
            resolveLoad = resolve;
        }));

        const loader = startConfigLoader(store);
        await settle();
        loader.stop();
        resolveLoad(false);
        await settle();

        expect(jest.getTimerCount()).toBe(0);
        await tick(CONFIG_RETRY_MAX_MS);
        expect(mockedLoad).toHaveBeenCalledTimes(1);
    });
});
