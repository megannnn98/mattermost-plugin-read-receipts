import {isDesktopClient} from './desktop';
import {reducer} from './reducer';
import {handleWebSocketEvent, WS_EVENT} from './websocket';
import {PLUGIN_ID} from './client';
import ReadReceipt from './components/read_receipt';
import {setStore} from './store_ref';
import {ChannelWatcher, startChannelWatcher} from './channel_watcher';
import {resetDeduplicator} from './actions';
import {resetVisibilityTracker} from './visibility';

declare global {
    interface Window {
        registerPlugin?: (id: string, plugin: unknown) => void;
    }
}

export class ReadReceiptsPlugin {
    private watcher: ChannelWatcher | null = null;

    initialize(registry: any, store: any): void {
        if (!isDesktopClient()) {
            console.debug(`[${PLUGIN_ID}] not Mattermost Desktop — plugin disabled`);
            return;
        }

        setStore(store);

        registry.registerReducer(reducer);

        registry.registerWebSocketEventHandler(WS_EVENT, (msg: unknown) => {
            handleWebSocketEvent(msg as never, store);
        });

        registry.registerPostMessageAttachmentComponent(ReadReceipt);

        this.watcher = startChannelWatcher(store);

        if (typeof registry.registerReconnectHandler === 'function') {
            registry.registerReconnectHandler(() => {
                this.watcher?.refresh();
            });
        }

        console.debug(`[${PLUGIN_ID}] desktop detected — plugin enabled`);
    }

    uninitialize(): void {
        this.watcher?.stop();
        this.watcher = null;
        resetDeduplicator();
        resetVisibilityTracker();
        setStore(null);
    }
}

window.registerPlugin?.(PLUGIN_ID, new ReadReceiptsPlugin());

export default ReadReceiptsPlugin;
