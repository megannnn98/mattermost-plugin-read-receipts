import {ACTION_TYPES} from '../src/reducer';
import {WS_EVENT, handleWebSocketEvent} from '../src/websocket';
import {makeGlobalState} from './helpers';

describe('handleWebSocketEvent', () => {
    let store: {dispatch: jest.Mock; getState: jest.Mock};
    let onCountChanged: jest.Mock;

    const stateWith = (type: string) => makeGlobalState({channels: {dm1: {id: 'dm1', type}}});

    beforeEach(() => {
        store = {dispatch: jest.fn(), getState: jest.fn().mockReturnValue(stateWith('D'))};
        onCountChanged = jest.fn();
    });

    const event = (data: Record<string, unknown>) => ({event: WS_EVENT, data});

    it('dispatches the receipt of a matching event', () => {
        handleWebSocketEvent(event({channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200, reader_id: 'reader'}), store, onCountChanged);

        expect(store.dispatch).toHaveBeenCalledWith({
            type: ACTION_TYPES.WS_RECEIPT,
            data: {channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200, reader_id: 'reader', isDM: true},
        });
    });

    it('coerces numeric fields delivered as strings', () => {
        handleWebSocketEvent(event({channel_id: 'dm1', post_id: 'p1', create_at: '100', read_at: '200', reader_id: 'reader'}), store);

        expect(store.dispatch.mock.calls[0][0].data).toMatchObject({create_at: 100, read_at: 200});
    });

    it('dispatches when author_id matches the current user', () => {
        handleWebSocketEvent(event({channel_id: 'dm1', post_id: 'p1', reader_id: 'reader', author_id: 'me'}), store);
        expect(store.dispatch).toHaveBeenCalled();
    });

    it('ignores an event addressed to another author', () => {
        handleWebSocketEvent(event({channel_id: 'dm1', post_id: 'p1', reader_id: 'reader', author_id: 'someoneElse'}), store);
        expect(store.dispatch).not.toHaveBeenCalled();
    });

    it('ignores an event without a reader id', () => {
        // The reducer keys read state by reader; a payload without one would be
        // recorded under an undefined reader.
        handleWebSocketEvent(event({channel_id: 'dm1', post_id: 'p1', create_at: 100, read_at: 200}), store);
        expect(store.dispatch).not.toHaveBeenCalled();
    });

    it('ignores other events and malformed payloads', () => {
        handleWebSocketEvent({event: 'other', data: {channel_id: 'dm1', post_id: 'p1', reader_id: 'r'}}, store);
        handleWebSocketEvent({event: WS_EVENT}, store);
        handleWebSocketEvent(event({post_id: 'p1', reader_id: 'r'}), store);
        expect(store.dispatch).not.toHaveBeenCalled();
    });

    it('does not ask for a re-query in a DM, where the event is the whole truth', () => {
        handleWebSocketEvent(event({channel_id: 'dm1', post_id: 'p1', reader_id: 'reader'}), store, onCountChanged);
        expect(onCountChanged).not.toHaveBeenCalled();
    });

    it('asks for a re-query outside a DM, where the count comes from the server', () => {
        store.getState.mockReturnValue(stateWith('G'));
        handleWebSocketEvent(event({channel_id: 'dm1', post_id: 'p1', reader_id: 'reader'}), store, onCountChanged);
        expect(onCountChanged).toHaveBeenCalledTimes(1);
    });
});
