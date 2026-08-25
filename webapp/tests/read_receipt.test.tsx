import React from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';

import ReadReceipt from '../src/components/read_receipt';
import {setStore} from '../src/store_ref';
import {getVisibilityTracker} from '../src/visibility';
import {sendReadReceipt} from '../src/actions';

jest.mock('../src/client', () => ({
    PLUGIN_ID: 'com.integrasources.read-receipts',
    fetchChannelReceipts: jest.fn(),
    reportRead: jest.fn().mockResolvedValue({
        post_id: 'p1',
        channel_id: 'channel1',
        create_at: 1000,
        read_at: 2000,
    }),
}));

jest.mock('../src/actions', () => ({
    sendReadReceipt: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/visibility', () => {
    const state = {isVisible: true, isFocused: true, isIdle: false};
    const listeners: Set<(s: typeof state) => void> = new Set();
    return {
        getVisibilityTracker: () => ({
            getState: () => ({...state}),
            isActive: () => state.isVisible && state.isFocused && !state.isIdle,
            subscribe: (cb: (s: typeof state) => void) => {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
            _set: (partial: Partial<typeof state>) => {
                Object.assign(state, partial);
                listeners.forEach((cb) => cb({...state}));
            },
        }),
        resetVisibilityTracker: jest.fn(),
    };
});

type IOEntry = {isIntersecting: boolean};

class MockIntersectionObserver {
    static callback: ((entries: IOEntry[]) => void) | null = null;
    constructor(callback: (entries: IOEntry[]) => void) {
        MockIntersectionObserver.callback = callback;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
}

function makeState() {
    return {
        entities: {
            users: {currentUserId: 'me'},
            channels: {
                currentChannelId: 'channel1',
                channels: {channel1: {id: 'channel1', type: 'D'}},
            },
            posts: {
                posts: {
                    p1: {id: 'p1', user_id: 'other', channel_id: 'channel1', create_at: 1000},
                },
            },
        },
    };
}

function makeStore() {
    const state = makeState();
    return {
        getState: () => state,
        dispatch: jest.fn(),
        subscribe: jest.fn().mockReturnValue(() => undefined),
    };
}

function fireIntersecting(entry: boolean) {
    MockIntersectionObserver.callback?.([{isIntersecting: entry}]);
}

describe('ReadReceipt component', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        jest.useFakeTimers();
        (window as any).IntersectionObserver = MockIntersectionObserver;
        MockIntersectionObserver.callback = null;
        (sendReadReceipt as jest.Mock).mockClear();
        setStore(makeStore());
        container = document.createElement('div');
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        setStore(null);
        jest.useRealTimers();
    });

    it('reports a read after the dwell when the window is active and the post visible', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
        expect(sendReadReceipt).toHaveBeenCalledWith('channel1', 'p1', 1000);
    });

    it('does not report while the window is not focused', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));
        (getVisibilityTracker() as any)._set({isFocused: false});

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).not.toHaveBeenCalled();
    });

    it('starts the dwell again when focus returns while the post is still visible', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));
        (getVisibilityTracker() as any)._set({isFocused: false});

        // The post enters the viewport while the window is unfocused.
        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).not.toHaveBeenCalled();

        // Focus returns with the post already visible: no new IntersectionObserver
        // callback fires, so the tracker state change must restart the dwell.
        act(() => (getVisibilityTracker() as any)._set({isFocused: true}));
        act(() => jest.advanceTimersByTime(1500));

        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
        expect(sendReadReceipt).toHaveBeenCalledWith('channel1', 'p1', 1000);
    });

    it('does not double-report after focus regain', () => {
        act(() => root.render(<ReadReceipt postId="p1"/>));
        (getVisibilityTracker() as any)._set({isFocused: false});

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        act(() => (getVisibilityTracker() as any)._set({isFocused: true}));
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledTimes(1);

        fireIntersecting(true);
        act(() => jest.advanceTimersByTime(1500));
        expect(sendReadReceipt).toHaveBeenCalledTimes(1);
    });
});
