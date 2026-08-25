import {
    isSufficientlyVisible,
    resolveObservedElement,
    VISIBILITY_THRESHOLD,
} from '../src/visibility_ratio';

describe('isSufficientlyVisible', () => {
    const root = () => ({height: 1000, width: 1920});

    it('is true when the intersection ratio meets the threshold', () => {
        const entry = {
            intersectionRatio: VISIBILITY_THRESHOLD,
            intersectionRect: {height: 750, width: 500},
            rootBounds: root(),
        };
        expect(isSufficientlyVisible(entry, VISIBILITY_THRESHOLD)).toBe(true);
    });

    it('is false when the ratio is below the threshold and the slice is small', () => {
        const entry = {
            intersectionRatio: 0.1,
            intersectionRect: {height: 100, width: 500},
            rootBounds: root(),
        };
        expect(isSufficientlyVisible(entry, VISIBILITY_THRESHOLD)).toBe(false);
    });

    it('is true for a tall post whose in-view slice fills the viewport', () => {
        // Post taller than the viewport: ratio 0.1, but the visible slice
        // (900px) >= 75% of the 1000px viewport.
        const entry = {
            intersectionRatio: 0.1,
            intersectionRect: {height: 900, width: 500},
            rootBounds: root(),
        };
        expect(isSufficientlyVisible(entry, VISIBILITY_THRESHOLD)).toBe(true);
    });

    it('is false when rootBounds is missing', () => {
        const entry = {
            intersectionRatio: 0.1,
            intersectionRect: {height: 900, width: 500},
            rootBounds: null,
        };
        expect(isSufficientlyVisible(entry, VISIBILITY_THRESHOLD)).toBe(false);
    });
});

describe('resolveObservedElement', () => {
    function makeSentinel(classes = ''): HTMLElement & {closest: (sel: string) => HTMLElement | null} {
        const el = document.createElement('div');
        el.className = classes;
        return el as unknown as HTMLElement & {closest: (sel: string) => HTMLElement | null};
    }

    it('prefers the closest .post element', () => {
        const parent = makeSentinel('post');
        const sentinel = makeSentinel();
        parent.appendChild(sentinel);
        expect(resolveObservedElement(sentinel)).toBe(parent);
    });

    it('falls back to .post__body when there is no .post', () => {
        const parent = makeSentinel('post__body');
        const sentinel = makeSentinel();
        parent.appendChild(sentinel);
        expect(resolveObservedElement(sentinel)).toBe(parent);
    });

    it('falls back to the parentElement', () => {
        const parent = makeSentinel();
        const sentinel = makeSentinel();
        parent.appendChild(sentinel);
        expect(resolveObservedElement(sentinel)).toBe(parent);
    });

    it('returns the sentinel itself when it has no parent', () => {
        const sentinel = makeSentinel();
        expect(resolveObservedElement(sentinel)).toBe(sentinel);
    });
});
