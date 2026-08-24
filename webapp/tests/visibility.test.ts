import {VisibilityTracker, resetVisibilityTracker} from '../src/visibility';

function setDocumentState(visible: boolean, focused: boolean) {
    Object.defineProperty(document, 'visibilityState', {
        value: visible ? 'visible' : 'hidden',
        writable: true,
        configurable: true,
    });
    jest.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

describe('VisibilityTracker', () => {
    beforeEach(() => {
        resetVisibilityTracker();
        setDocumentState(true, true);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('starts inactive when the window is not focused at construction', () => {
        setDocumentState(true, false);
        expect(new VisibilityTracker().isActive()).toBe(false);
    });

    it('starts inactive when the document is hidden at construction', () => {
        setDocumentState(false, true);
        expect(new VisibilityTracker().isActive()).toBe(false);
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
