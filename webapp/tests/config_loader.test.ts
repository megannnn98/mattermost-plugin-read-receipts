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

    it('reload after a give-up runs the whole sequence again, not one last try', async () => {
        mockedLoad.mockResolvedValue(false);
        const loader = startConfigLoader(store);
        await settle();
        for (let i = 0; i < CONFIG_MAX_ATTEMPTS; i++) {
            await tick(CONFIG_RETRY_MAX_MS);
        }
        const afterGiveUp = mockedLoad.mock.calls.length;

        // Still failing. Carrying the old attempt count over would make this
        // single request the give-up as well, so a reconnect would buy nothing.
        const second = loader.reload();
        await settle();
        expect(mockedLoad).toHaveBeenCalledTimes(afterGiveUp + 1);
        for (let i = 0; i < CONFIG_MAX_ATTEMPTS; i++) {
            await tick(CONFIG_RETRY_MAX_MS);
        }

        await expect(second).resolves.toBe(false);
        expect(mockedLoad).toHaveBeenCalledTimes(afterGiveUp + CONFIG_MAX_ATTEMPTS);
        loader.stop();
    });

    it('reload resolves with the outcome of the whole sequence, not of the first attempt', async () => {
        // The reconnect path refreshes the channel watcher only when reload
        // reports success. A promise tied to the first attempt would report the
        // 401 and skip that refresh — and the watcher, still holding the channel
        // in handledChannelId, would never re-query with the fresh configuration.
        mockedLoad.mockResolvedValueOnce(false).mockResolvedValue(true);

        const loader = startConfigLoader(store);
        await settle();
        mockedLoad.mockResolvedValueOnce(false).mockResolvedValue(true);
        const outcome = loader.reload();
        await settle();
        await tick(CONFIG_RETRY_BASE_MS);

        await expect(outcome).resolves.toBe(true);
        loader.stop();
    });

    it('a superseded attempt cannot schedule work or clear a configuration that already landed', async () => {
        // The startup attempt is still in flight when a reconnect starts a new
        // sequence. loadPluginConfig reports a superseded response as a failure,
        // so without an epoch the old attempt would schedule a retry, and that
        // retry would dispatch CONFIG_LOADING over the configuration the new
        // sequence had just loaded — putting the plugin back to inert.
        let settleFirst: (value: boolean) => void = () => undefined;
        mockedLoad.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            settleFirst = resolve;
        }));
        mockedLoad.mockResolvedValue(true);

        const loader = startConfigLoader(store);
        await settle();
        expect(mockedLoad).toHaveBeenCalledTimes(1);

        await expect(loader.reload()).resolves.toBe(true);
        const callsAfterReload = mockedLoad.mock.calls.length;

        settleFirst(false);
        await settle();

        // Checked before any clock movement: a retry scheduled here is the
        // defect, and advancing time first would let it fire and clear itself.
        expect(jest.getTimerCount()).toBe(0);

        await tick(CONFIG_RETRY_MAX_MS);
        expect(mockedLoad).toHaveBeenCalledTimes(callsAfterReload);
        loader.stop();
    });

    it('reports the cause when it gives up, not just the attempt count', async () => {
        const cause = new Error('Request failed: 500 Internal Server Error');
        mockedLoad.mockImplementation(async (_store, onFailure) => {
            onFailure?.(cause);
            return false;
        });

        const loader = startConfigLoader(store);
        await settle();
        for (let i = 0; i < CONFIG_MAX_ATTEMPTS; i++) {
            await tick(CONFIG_RETRY_MAX_MS);
        }

        expect(console.error).toHaveBeenCalledTimes(1);
        expect((console.error as jest.Mock).mock.calls[0]).toContain(cause);
        loader.stop();
    });
});
