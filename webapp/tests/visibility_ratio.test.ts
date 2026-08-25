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

    // The container is chosen by CSS alone. A channel with few posts, or one whose
    // images have not loaded yet, does not overflow at mount time; the root is
    // picked once, so a geometry-dependent choice would pin the observer to the
    // window for the whole mount and bring back the unreachable tall-post branch.
    it('picks the post list before it overflows, and keeps it after it grows', () => {
        const list = scrollable('auto', 492, 492);   // scrollHeight === clientHeight
        const post = document.createElement('div');
        list.appendChild(post);
        document.body.appendChild(list);

        expect(resolveScrollRoot(post)).toBe(list);

        // Async content (an image, an attachment, an expanded message) arrives.
        Object.defineProperty(list, 'scrollHeight', {value: 6584, configurable: true});
        expect(resolveScrollRoot(post)).toBe(list);

        document.body.removeChild(list);
    });

    it('prefers the nearest scroll container over a farther one', () => {
        const outer = scrollable('auto', 5000, 492);
        const inner = scrollable('auto', 300, 300);
        outer.appendChild(inner);
        const post = document.createElement('div');
        inner.appendChild(post);
        document.body.appendChild(outer);

        expect(resolveScrollRoot(post)).toBe(inner);
        document.body.removeChild(outer);
    });

    it.each([
        ['visible', 'visible'],
        ['hidden', 'hidden'],
    ])('does not treat overflow-y: %s as a scroll root', (_name, overflowY) => {
        // Measured in the live client: #postListContent, #post-list, .main-wrapper,
        // #root and body are all overflow-y: hidden and sit ABOVE the real
        // scroller, so they clip without scrolling and must not become the root.
        const wrapper = scrollable(overflowY, 5000, 492);
        const post = document.createElement('div');
        wrapper.appendChild(post);
        document.body.appendChild(wrapper);

        expect(resolveScrollRoot(post)).toBeNull();
        document.body.removeChild(wrapper);
    });

    it('walks past non-scrolling wrappers to reach the post list', () => {
        // The live chain has three overflow-y: visible wrappers between .post and
        // div.post-list__dynamic.
        const list = scrollable('auto', 6584, 492);
        let node: HTMLElement = list;
        for (let i = 0; i < 3; i++) {
            const wrapper = scrollable('visible', 6584, 6584);
            node.appendChild(wrapper);
            node = wrapper;
        }
        const post = document.createElement('div');
        node.appendChild(post);
        document.body.appendChild(list);

        expect(resolveScrollRoot(post)).toBe(list);
        document.body.removeChild(list);
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
