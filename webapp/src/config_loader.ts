import {loadPluginConfig} from './actions';
import {PLUGIN_ID} from './client';
import {PluginStore} from './types';

// The configuration request can lose a race with the session at startup: the
// webapp initializes plugins while the auth cookie is still being established,
// and the endpoint answers 401. Measured on Mattermost 9.11 and 11.7.2 alike.
export const CONFIG_RETRY_BASE_MS = 1000;
export const CONFIG_RETRY_MAX_MS = 30000;
// Bounded on purpose. Without the configuration the plugin is completely inert,
// so giving up quickly would leave it dead for the whole session; retrying
// forever would leave a timer running behind a permanently broken endpoint. Six
// attempts cover roughly a minute, and a reconnect starts the sequence over.
export const CONFIG_MAX_ATTEMPTS = 6;

export interface ConfigLoader {
    stop: () => void;
    reload: () => Promise<boolean>;
}

/**
 * Keeps trying to load the plugin configuration until it lands.
 *
 * The plugin gates everything on this value — a channel type it has not been
 * told about is treated as disabled — so a single failed request used to mean no
 * indicators and no read reports until the next websocket reconnect, with only a
 * console line to show for it.
 */
export function startConfigLoader(store: PluginStore): ConfigLoader {
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const clear = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const run = async (): Promise<boolean> => {
        if (stopped) {
            return false;
        }
        const loaded = await loadPluginConfig(store);
        if (stopped) {
            return false;
        }
        if (loaded) {
            attempts = 0;
            clear();
            return true;
        }

        attempts += 1;
        if (attempts >= CONFIG_MAX_ATTEMPTS) {
            // Only the final failure is worth a user-visible console line; the
            // intermediate ones are an expected startup race.
            console.error(`[${PLUGIN_ID}] Giving up on the plugin configuration after ${attempts} attempts — no receipts will be shown until the next reconnect.`);
            return false;
        }

        const delay = Math.min(CONFIG_RETRY_BASE_MS * (2 ** (attempts - 1)), CONFIG_RETRY_MAX_MS);
        clear();
        timer = setTimeout(() => {
            timer = null;
            void run();
        }, delay);
        return false;
    };

    void run();

    return {
        stop: () => {
            stopped = true;
            clear();
        },
        // A reconnect is both a fresh chance after a give-up and the moment an
        // administrator's change can have happened, so the backoff starts over.
        reload: () => {
            clear();
            attempts = 0;
            return run();
        },
    };
}
