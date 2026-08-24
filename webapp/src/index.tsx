import {isDesktopClient} from './desktop';
import {reducer} from './reducer';
import {handleWebSocketEvent} from './websocket';
import {PLUGIN_ID} from './client';
import ReadReceipt from './components/read_receipt';
import {setStore} from './store_ref';

export default function initialize(registry: any, store: any) {
    if (!isDesktopClient()) {
        if ((window as any).console?.debug) {
            // eslint-disable-next-line no-console
            console.debug(`[${PLUGIN_ID}] Not Mattermost Desktop — plugin disabled`);
        }
        return;
    }

    setStore(store);

    registry.registerReducer(reducer);

    registry.registerWebSocketEventHandler(
        `custom_${PLUGIN_ID}_read_receipt`,
        (event: string, data: any) => handleWebSocketEvent(event, data, store),
    );

    registry.registerPostMessageAttachmentComponent(ReadReceipt);

    // eslint-disable-next-line no-console
    console.debug(`[${PLUGIN_ID}] Desktop detected — plugin enabled`);
}
