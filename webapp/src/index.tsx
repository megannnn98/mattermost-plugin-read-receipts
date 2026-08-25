import {isDesktopClient} from './desktop';
import {reducer} from './reducer';
import {handleReceiptsChangedEvent, handleWebSocketEvent, WS_EVENT, WS_RECEIPTS_CHANGED_EVENT} from './websocket';
import {PLUGIN_ID} from './client';
import ReadReceipt from './components/read_receipt';
import {setStore} from './store_ref';
import {ChannelWatcher, startChannelWatcher} from './channel_watcher';
import {invalidatePluginConfigRequests, loadPluginConfig, resetDeduplicator} from './actions';
import {resetVisibilityTracker} from './visibility';
import {PluginRegistry, PluginStore} from './types';

declare global {
    interface Window {
        registerPlugin?: (id: string, plugin: unknown) => void;
    }
}

export class ReadReceiptsPlugin {
    private watcher: ChannelWatcher | null = null;

    initialize(registry: PluginRegistry, store: PluginStore): void {
        if (!isDesktopClient()) {
            console.debug(`[${PLUGIN_ID}] not Mattermost Desktop — plugin disabled`);
            return;
        }

        setStore(store);

        registry.registerReducer(reducer);

        registry.registerWebSocketEventHandler(WS_EVENT, (msg) => {
            handleWebSocketEvent(msg, store, () => this.watcher?.refreshSoon());
        });
        registry.registerWebSocketEventHandler(WS_RECEIPTS_CHANGED_EVENT, (msg) => {
            handleReceiptsChangedEvent(msg, store, () => this.watcher?.refreshSoon());
        });

        registry.registerPostMessageAttachmentComponent(ReadReceipt);

        this.watcher = startChannelWatcher(store);

        // Until the configuration lands the plugin stays inert: no indicator, no
        // read report. Dispatching it wakes the watcher through its own store
        // subscription, so nothing else needs to be scheduled here.
        loadPluginConfig(store);

        if (typeof registry.registerReconnectHandler === 'function') {
            registry.registerReconnectHandler(() => {
                // A reconnect is the point at which an administrator's change to
                // the setting can have happened. Clear the previous allow-list
                // first; only a successful fresh response may wake the watcher.
                void loadPluginConfig(store).then((loaded) => {
                    if (loaded) {
                        this.watcher?.refresh();
                    }
                });
            });
        }

        console.debug(`[${PLUGIN_ID}] desktop detected — plugin enabled`);
    }

    uninitialize(): void {
        invalidatePluginConfigRequests();
        this.watcher?.stop();
        this.watcher = null;
        resetDeduplicator();
        resetVisibilityTracker();
        setStore(null);
    }
}

window.registerPlugin?.(PLUGIN_ID, new ReadReceiptsPlugin());

export default ReadReceiptsPlugin;
