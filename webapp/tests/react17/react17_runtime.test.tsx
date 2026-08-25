import React from 'react';
import * as ReactDOM from 'react-dom';
import {act} from 'react-dom/test-utils';

import {usePluginSelector} from '../../src/hooks';
import ReadReceipt from '../../src/components/read_receipt';
import {setStore} from '../../src/store_ref';

jest.mock('../../src/actions', () => ({sendReadReceipt: jest.fn(), loadPostReaders: jest.fn().mockResolvedValue(undefined)}));
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
            'plugins-com.integrasources.read-receipts': {
                statuses: {p1: {count: 1, truncated: false, read_at: 60000}},
                readers: {},
                profiles: {},
                profilesRevision: 0,
                config: {enabled_channel_types: 'DGPO'},
            },
        }));

        const postBody = document.createElement('div');
        postBody.className = 'post__body';
        const text = document.createElement('div');
        text.className = 'post-message__text';
        postBody.append(text, container);
        document.body.appendChild(postBody);

        act(() => {
            (ReactDOM as any).render(<ReadReceipt postId="p1"/>, container);
        });
        expect(text.querySelector('svg[data-tick="read"]')).not.toBeNull();
    });
    it('renders the group indicator and its popover on the React 17 the webapp ships', () => {
        // Mattermost 9.5+ gives plugins React 17.0.2: no createRoot, no
        // useSyncExternalStore. The portal-based indicator and the popover must
        // work on that runtime, not just on the React 18 used by most tests.
        setStore(makeStore({
            entities: {
                users: {currentUserId: 'me', profiles: {me: {locale: 'ru'}}},
                channels: {currentChannelId: 'g1', channels: {g1: {id: 'g1', type: 'G'}}},
                posts: {posts: {p1: {id: 'p1', user_id: 'me', channel_id: 'g1', create_at: 1000}}},
            },
            'plugins-com.integrasources.read-receipts': {
                statuses: {p1: {count: 1, truncated: false, read_at: null}},
                readers: {p1: {list: [{user_id: 'a', read_at: 5100, exact: true}], truncated: false, nextOffset: 0}},
                profiles: {a: {username: 'ada'}},
                profilesRevision: 1,
                config: {enabled_channel_types: 'DGPO'},
            },
        }));

        const postBody = document.createElement('div');
        postBody.className = 'post__body';
        const text = document.createElement('div');
        text.className = 'post-message__text';
        postBody.append(text, container);
        document.body.appendChild(postBody);

        act(() => {
            (ReactDOM as any).render(<ReadReceipt postId="p1"/>, container);
        });
        expect(text.querySelector('svg[data-tick="read"]')).not.toBeNull();
        expect(text.textContent).toContain('1');

        act(() => {
            (text.querySelector('button') as HTMLButtonElement).click();
        });
        expect(document.querySelector('[role="dialog"]')!.textContent).toContain('ada');
    });
});
