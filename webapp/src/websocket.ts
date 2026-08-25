import {PLUGIN_ID} from './client';
import {ACTION_TYPES} from './reducer';
import {PluginStore, WebSocketMessage} from './types';

export const WS_EVENT = `custom_${PLUGIN_ID}_read_receipt`;
export const WS_RECEIPTS_CHANGED_EVENT = `custom_${PLUGIN_ID}_receipts_changed`;

/**
 * `registerWebSocketEventHandler` passes the whole websocket message as the only
 * argument (`{event, data, broadcast, seq}`), not (event, data).
 */
export function handleWebSocketEvent(msg: WebSocketMessage, store: PluginStore, onCountChanged?: () => void): void {
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

    // A DM has exactly one other member, so the event alone is the whole truth
    // there — one reader, at this time. Anywhere else it only proves that someone
    // read the post; the authoritative count comes from the next query.
    const channel = store.getState()?.entities?.channels?.channels?.[channelId];

    store.dispatch({
        type: ACTION_TYPES.WS_RECEIPT,
        data: {
            channel_id: channelId,
            post_id: postId,
            create_at: Number(msg.data.create_at ?? 0),
            read_at: Number(msg.data.read_at ?? 0),
            reader_id: readerId,
            isDM: channel?.type === 'D',
        },
    });

    // Outside a DM the event says "at least one more person read this" but not
    // how many, so the accurate number has to come from a re-query.
    if (channel?.type !== 'D') {
        onCountChanged?.();
    }
}

/**
 * A channel-level invalidation is intentionally less detailed than a receipt:
 * it identifies only the channel and asks the author to refresh their own posts.
 * The query endpoint remains the sole authority for counts, so this event cannot
 * reveal who read a foreign post or how far that person read.
 */
export function handleReceiptsChangedEvent(msg: WebSocketMessage, store: PluginStore, onChanged?: () => void): void {
    if (!msg || msg.event !== WS_RECEIPTS_CHANGED_EVENT || !msg.data) {
        return;
    }

    const channelId = msg.data.channel_id;
    const state = store.getState();
    if (!channelId || channelId !== state?.entities?.channels?.currentChannelId || !state?.entities?.channels?.channels?.[channelId]) {
        return;
    }

    onChanged?.();
}
