import {PLUGIN_ID} from './client';
import {ACTION_TYPES} from './reducer';

export const WS_EVENT = `custom_${PLUGIN_ID}_read_receipt`;

interface WebSocketMessage {
    event?: string;
    data?: {
        channel_id?: string;
        post_id?: string;
        create_at?: number | string;
        read_at?: number | string;
        reader_id?: string;
    };
}

/**
 * `registerWebSocketEventHandler` passes the whole websocket message as the only
 * argument (`{event, data, broadcast, seq}`), not (event, data).
 */
export function handleWebSocketEvent(msg: WebSocketMessage, store: any): void {
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
