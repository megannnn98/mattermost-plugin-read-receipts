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

    // The server addresses the event to the post's author and also includes
    // author_id in the payload. A non-empty author_id that is not the current
    // user is a cross-checking signal that this event is not meant for us — the
    // addressed broadcast should already have filtered it, but this defends
    // against a mis-addressed broadcast.
    const {author_id: authorId} = msg.data;
    if (authorId) {
        const currentUserId = store.getState()?.entities?.users?.currentUserId;
        if (authorId !== currentUserId) {
            return;
        }
    }

    const {channel_id: channelId, post_id: postId, reader_id: readerId} = msg.data;
    if (!channelId || !postId || !readerId) {
        return;
    }

    store.dispatch({
        type: ACTION_TYPES.WS_RECEIPT,
        data: {
            channel_id: channelId,
            post_id: postId,
            create_at: Number(msg.data.create_at ?? 0),
            read_at: Number(msg.data.read_at ?? 0),
            reader_id: readerId,
        },
    });
}
