import {PLUGIN_ID} from './client';

export function handleWebSocketEvent(event: string, data: any, store: any): void {
    const expectedEvent = `custom_${PLUGIN_ID}_read_receipt`;
    if (event !== expectedEvent) {
        return;
    }

    store.dispatch({
        type: `${PLUGIN_ID}_WS_RECEIPT`,
        data,
    });
}
