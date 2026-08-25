import {
    isSufficientlyVisible,
    resolveObservedElement,
    resolveScrollRoot,
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

describe('resolveScrollRoot', () => {
    const scrollable = (overflowY: string, scrollHeight: number, clientHeight: number) => {
        const el = document.createElement('div');
        el.style.overflowY = overflowY;
        Object.defineProperty(el, 'scrollHeight', {value: scrollHeight, configurable: true});
        Object.defineProperty(el, 'clientHeight', {value: clientHeight, configurable: true});
        return el;
    };

    it('finds the nearest scrolling ancestor', () => {
        const list = scrollable('auto', 5000, 492);
        const post = document.createElement('div');
        list.appendChild(post);
        document.body.appendChild(list);

        expect(resolveScrollRoot(post)).toBe(list);
        document.body.removeChild(list);
    });

    it('skips ancestors that do not actually scroll', () => {
        const outer = scrollable('auto', 5000, 492);
        const inner = scrollable('auto', 100, 100);
        outer.appendChild(inner);
        const post = document.createElement('div');
        inner.appendChild(post);
        document.body.appendChild(outer);

        expect(resolveScrollRoot(post)).toBe(outer);
        document.body.removeChild(outer);
    });

    it('returns null when nothing scrolls, keeping the viewport as the root', () => {
        const plain = document.createElement('div');
        const post = document.createElement('div');
        plain.appendChild(post);
        document.body.appendChild(plain);

        expect(resolveScrollRoot(post)).toBeNull();
        document.body.removeChild(plain);
    });
});

// Geometry measured in a live Mattermost Desktop 6.3.0 window: an 8063px post in
// a 492px post list inside a 760px window. The visible slice can never exceed the
// list height, so measuring the tall-post branch against the window made it
// unreachable and such a post was never reported as read at all.
describe('tall post in the real Mattermost layout', () => {
    const WINDOW_H = 760;
    const LIST_H = 492;
    const POST_H = 8063;
    const VISIBLE = 487;
    const entry = (rootHeight: number) => ({
        intersectionRatio: VISIBLE / POST_H,
        intersectionRect: {height: VISIBLE},
        rootBounds: {height: rootHeight},
    });

    it('is unreachable when measured against the window', () => {
        expect(VISIBLE).toBeLessThan(WINDOW_H * VISIBILITY_THRESHOLD);
        expect(isSufficientlyVisible(entry(WINDOW_H), VISIBILITY_THRESHOLD)).toBe(false);
    });

    it('is satisfied when measured against the post list, which is the observer root', () => {
        expect(isSufficientlyVisible(entry(LIST_H), VISIBILITY_THRESHOLD)).toBe(true);
        expect(VISIBLE / POST_H).toBeLessThan(VISIBILITY_THRESHOLD);
    });
});
