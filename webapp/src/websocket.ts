import {PLUGIN_ID} from './client';
import {ACTION_TYPES} from './reducer';
import {PluginStore, WebSocketMessage} from './types';

export const WS_EVENT = `custom_${PLUGIN_ID}_read_receipt`;

/**
 * `registerWebSocketEventHandler` passes the whole websocket message as the only
 * argument (`{event, data, broadcast, seq}`), not (event, data).
 */
export function handleWebSocketEvent(msg: WebSocketMessage, store: PluginStore): void {
    if (!msg || msg.event !== WS_EVENT || !msg.data) {
        return;
    }

    const {channel_id: channelId, post_id: postId} = msg.data;
    if (!channelId || !postId) {
        return;
    }

    store.dispatch({
        type: ACTION_TYPES.WS_RECEIPT,
        data: {
            channel_id: channelId,
            post_id: postId,
            create_at: Number(msg.data.create_at ?? 0),
            read_at: Number(msg.data.read_at ?? 0),
        },
    });
}
