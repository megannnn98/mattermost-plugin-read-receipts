import React from 'react';
import * as ReactDOM from 'react-dom';
import {act} from 'react-dom/test-utils';

import {usePluginSelector} from '../../src/hooks';
import ReadReceipt from '../../src/components/read_receipt';
import {setStore} from '../../src/store_ref';

jest.mock('../../src/actions', () => ({sendReadReceipt: jest.fn()}));
jest.mock('../../src/visibility', () => ({
    getVisibilityTracker: () => ({isActive: () => true, subscribe: () => () => undefined}),
}));

function makeStore(initial: any) {
    let state = initial;
    const listeners: Array<() => void> = [];
    return {
        getState: () => state,
        setState: (next: any) => {
            state = next;
            listeners.forEach((listener) => listener());
        },
        dispatch: jest.fn(),
        subscribe: (listener: () => void) => {
            listeners.push(listener);
            return () => listeners.splice(listeners.indexOf(listener), 1);
        },
    };
}

describe('React 17 runtime', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        expect((require('react') as typeof React).useSyncExternalStore).toBeUndefined();
        container = document.createElement('div');
    });

    afterEach(() => {
        act(() => {
            (ReactDOM as any).unmountComponentAtNode(container);
        });
        setStore(null);
    });

    it('updates only for relevant store changes and recomputes on a postId prop change', () => {
        const store = makeStore({values: {one: 'first', two: 'second'}, irrelevant: 0});
        let renders = 0;
        const Selected: React.FC<{postId: string}> = ({postId}) => {
            renders += 1;
            return <span>{usePluginSelector(store, (state: any) => state.values[postId])}</span>;
        };

        act(() => {
            (ReactDOM as any).render(<Selected postId="one"/>, container);
        });
        expect(container.textContent).toBe('first');
        expect(renders).toBe(1);

        act(() => store.setState({values: {one: 'first', two: 'second'}, irrelevant: 1}));
        expect(renders).toBe(1);

        act(() => store.setState({values: {one: 'updated', two: 'second'}, irrelevant: 1}));
        expect(container.textContent).toBe('updated');
        expect(renders).toBe(2);

        act(() => {
            (ReactDOM as any).render(<Selected postId="two"/>, container);
        });
        expect(container.textContent).toBe('second');
    });

    it('mounts ReadReceipt and displays a read timestamp', () => {
        setStore(makeStore({
            entities: {
                users: {currentUserId: 'me', profiles: {me: {locale: 'ru'}}},
                channels: {channels: {dm1: {id: 'dm1', type: 'D'}}},
                posts: {posts: {p1: {id: 'p1', user_id: 'me', channel_id: 'dm1', create_at: 1}}},
            },
            [`plugins-com.integrasources.read-receipts`]: {receipts: {p1: 60000}, watermarks: {}},
        }));

        act(() => {
            (ReactDOM as any).render(<ReadReceipt postId="p1"/>, container);
        });
        const svg = container.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute('aria-label')).toBe('Прочитано');
        const title = container.querySelector('.read-receipt-ticks-attachment')?.getAttribute('title');
        expect(title).toMatch(/^Прочитано в \d{2}:\d{2}$/);
    });
});
