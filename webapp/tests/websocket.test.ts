import {ACTION_TYPES} from '../src/reducer';
import {WS_EVENT, handleWebSocketEvent} from '../src/websocket';

describe('handleWebSocketEvent', () => {
    let store: {dispatch: jest.Mock; getState: jest.Mock};

    beforeEach(() => {
        store = {
            dispatch: jest.fn(),
            getState: jest.fn().mockReturnValue({entities: {users: {currentUserId: 'me'}}}),
        };
    });

    it('dispatches the receipt of a matching event', () => {
        handleWebSocketEvent(
            {
                event: WS_EVENT,
                data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200, reader_id: 'reader'},
            },
            store,
        );

        expect(store.dispatch).toHaveBeenCalledWith({
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200, reader_id: 'reader'},
        });
    });

    it('coerces numeric fields delivered as strings', () => {
        handleWebSocketEvent(
            {
                event: WS_EVENT,
                data: {channel_id: 'dm1', post_id: 'p1', create_at: '100', read_at: '200', reader_id: 'reader'},
            },
            store,
        );

        expect(store.dispatch).toHaveBeenCalledWith({
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200, reader_id: 'reader'},
        });
    });

    it('dispatches when author_id matches the current user', () => {
        handleWebSocketEvent(
            {
                event: WS_EVENT,
                data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200, reader_id: 'reader', author_id: 'me'},
            },
            store,
        );

        expect(store.dispatch).toHaveBeenCalledWith({
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200, reader_id: 'reader'},
        });
    });

    it('ignores an event addressed to another author', () => {
        handleWebSocketEvent(
            {
                event: WS_EVENT,
                data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200, author_id: 'someone-else'},
            },
            store,
        );

        expect(store.dispatch).not.toHaveBeenCalled();
    });

    it('ignores other events and malformed payloads', () => {
        handleWebSocketEvent({event: 'posted', data: {post_id: 'p1', channel_id: 'dm1'}}, store);
        handleWebSocketEvent({event: WS_EVENT}, store);
        handleWebSocketEvent({event: WS_EVENT, data: {post_id: 'p1'}}, store);
        handleWebSocketEvent({event: WS_EVENT, data: {post_id: 'p1', channel_id: 'dm1'}}, store);
        handleWebSocketEvent(undefined as never, store);

        expect(store.dispatch).not.toHaveBeenCalled();
    });
    it('ignores an event without a reader id', () => {
        // The reducer keys state by reader; a payload without one would create a
        // bogus `undefined` reader and corrupt every count in the channel.
        handleWebSocketEvent(
            {
                event: WS_EVENT,
                data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200},
            },
            store,
        );

        expect(store.dispatch).not.toHaveBeenCalled();
    });
});
