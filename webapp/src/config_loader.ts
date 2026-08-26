import {loadPluginConfig} from './actions';
import {PLUGIN_ID} from './client';
import {PluginStore} from './types';

// The configuration request can lose a race with the session at startup: the
// webapp initializes plugins while the auth cookie is still being established,
// and the endpoint answers 401. Measured on Mattermost 9.11 and 11.7.2 alike.
export const CONFIG_RETRY_BASE_MS = 1000;
// A ceiling on the doubling rather than a delay the current budget ever reaches:
// six attempts wait 1+2+4+8+16 s. It exists so that raising the budget stays safe.
export const CONFIG_RETRY_MAX_MS = 30000;
// Bounded on purpose. Without the configuration the plugin is completely inert,
// so giving up quickly would leave it dead for the whole session; retrying
// forever would leave a timer running behind a permanently broken endpoint. Six
// attempts span 31 s of waiting plus up to six request timeouts.
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
    // Identifies the current attempt sequence. `reload` and `stop` supersede
    // whatever was running, and every step re-checks the epoch after it awaits.
    //
    // Without this, an attempt still in flight when a reconnect starts a new
    // sequence comes back as a failure — `loadPluginConfig` reports a superseded
    // response as one — and would then schedule a retry that dispatches
    // CONFIG_LOADING over the configuration the new sequence had just loaded,
    // putting the plugin back to inert.
    let epoch = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const clear = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    // Supersession is handled by `clear()` in `start`/`stop` — a cancelled timer
    // never fires — and by the epoch check after each request. There is
    // deliberately no epoch test here: it could never be false, and a guard no
    // test can reach is not a guard.
    const waitFor = (ms: number) => new Promise<boolean>((resolve) => {
        clear();
        timer = setTimeout(() => {
            timer = null;
            resolve(!stopped);
        }, ms);
    });

    /**
     * Runs a whole attempt sequence and resolves once it has settled — loaded, or
     * given up. Callers therefore learn the real outcome even when the first
     * attempt failed and a later retry is what succeeded. A promise tied to the
     * first attempt alone would report a failure the loader went on to recover
     * from, and the reconnect path would skip the watcher refresh that the fresh
     * configuration needs — leaving the watcher holding the channel in
     * `handledChannelId` and never re-querying it.
     */
    const runSequence = async (myEpoch: number): Promise<boolean> => {
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= CONFIG_MAX_ATTEMPTS; attempt++) {
            const loaded = await loadPluginConfig(store, (error) => {
                lastError = error;
            });
            if (stopped || epoch !== myEpoch) {
                return false;
            }
            if (loaded) {
                clear();
                return true;
            }
            if (attempt === CONFIG_MAX_ATTEMPTS) {
                // Only the final failure is worth a user-visible line — the
                // intermediate ones are an expected startup race — and it carries
                // the cause, which is the whole point of reporting it.
                console.error(
                    `[${PLUGIN_ID}] Giving up on the plugin configuration after ${attempt} attempts — no receipts will be shown until the next reconnect. Last error:`,
                    lastError,
                );
                return false;
            }
            const delay = Math.min(CONFIG_RETRY_BASE_MS * (2 ** (attempt - 1)), CONFIG_RETRY_MAX_MS);
            if (!(await waitFor(delay))) {
                return false;
            }
        }
        return false;
    };

    const start = (): Promise<boolean> => {
        clear();
        epoch += 1;
        return runSequence(epoch);
    };

    void start();

    return {
        stop: () => {
            stopped = true;
            epoch += 1;
            clear();
        },
        // A reconnect is both a fresh chance after a give-up and the moment an
        // administrator's change can have happened, so the backoff starts over.
        reload: () => start(),
    };
}
