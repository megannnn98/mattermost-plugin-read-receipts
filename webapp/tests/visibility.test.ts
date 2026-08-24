import {VisibilityTracker, resetVisibilityTracker} from '../src/visibility';

describe('VisibilityTracker', () => {
    beforeEach(() => {
        resetVisibilityTracker();
    });

    it('starts active by default', () => {
        const tracker = new VisibilityTracker();
        expect(tracker.isActive()).toBe(true);
    });

    it('becomes inactive on blur', () => {
        const tracker = new VisibilityTracker();
        window.dispatchEvent(new Event('blur'));
        expect(tracker.isActive()).toBe(false);
    });

    it('becomes active again on focus', () => {
        const tracker = new VisibilityTracker();
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
        expect(tracker.isActive()).toBe(true);
    });

    it('becomes inactive on visibility change to hidden', () => {
        const tracker = new VisibilityTracker();
        Object.defineProperty(document, 'visibilityState', {
            value: 'hidden',
            writable: true,
            configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(tracker.isActive()).toBe(false);
    });

    it('notifies subscribers on state change', () => {
        const tracker = new VisibilityTracker();
        const callback = jest.fn();
        tracker.subscribe(callback);

        window.dispatchEvent(new Event('blur'));
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({isFocused: false}),
        );
    });

    it('unsubscribes correctly', () => {
        const tracker = new VisibilityTracker();
        const callback = jest.fn();
        const unsubscribe = tracker.subscribe(callback);

        unsubscribe();
        window.dispatchEvent(new Event('blur'));
        expect(callback).not.toHaveBeenCalled();
    });
});
