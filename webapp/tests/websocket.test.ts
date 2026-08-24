import {ACTION_TYPES} from '../src/reducer';
import {WS_EVENT, handleWebSocketEvent} from '../src/websocket';

describe('handleWebSocketEvent', () => {
    let store: {dispatch: jest.Mock};

    beforeEach(() => {
        store = {dispatch: jest.fn()};
    });

    it('dispatches the receipt of a matching event', () => {
        handleWebSocketEvent(
            {
                event: WS_EVENT,
                data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200},
            },
            store,
        );

        expect(store.dispatch).toHaveBeenCalledWith({
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200},
        });
    });

    it('coerces numeric fields delivered as strings', () => {
        handleWebSocketEvent(
            {
                event: WS_EVENT,
                data: {channel_id: 'dm1', post_id: 'p1', create_at: '100', read_at: '200'},
            },
            store,
        );

        expect(store.dispatch).toHaveBeenCalledWith({
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200},
        });
    });

    it('ignores other events and malformed payloads', () => {
        handleWebSocketEvent({event: 'posted', data: {post_id: 'p1', channel_id: 'dm1'}}, store);
        handleWebSocketEvent({event: WS_EVENT}, store);
        handleWebSocketEvent({event: WS_EVENT, data: {post_id: 'p1'}}, store);
        handleWebSocketEvent(undefined as never, store);

        expect(store.dispatch).not.toHaveBeenCalled();
    });
});
