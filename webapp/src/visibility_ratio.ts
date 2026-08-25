// Pure visibility helpers for deciding whether a post is "seen enough" to
// count as read. Kept dependency-free so they are directly unit-testable.

export const VISIBILITY_THRESHOLD = 0.75;
export const VISIBILITY_THRESHOLDS = [
    0,
    0.001,
    0.002,
    0.003,
    0.004,
    0.005,
    0.006,
    0.0075,
    ...Array.from({length: 100}, (_, index) => (index + 1) / 100),
];

export interface RectLike {
    height: number;
}

export interface IntersectionObserverEntryLike {
    intersectionRatio: number;
    intersectionRect: RectLike;
    rootBounds: RectLike | null;
}

/**
 * The component renders a zero-sized sentinel span. A post taller than the viewport
 * can never reach a 0.75 intersection ratio, and the sentinel alone does not
 * represent the visible area, so resolve to the nearest real post element when
 * possible: .post > .post__body > the sentinel's parent > the sentinel itself.
 */
export function resolveObservedElement(sentinel: Element): Element {
    if (typeof sentinel.closest === 'function') {
        const post = sentinel.closest('.post');
        if (post) {
            return post;
        }
        const body = sentinel.closest('.post__body');
        if (body) {
            return body;
        }
    }
    return sentinel.parentElement ?? sentinel;
}

const SCROLLABLE_OVERFLOW_Y = new Set(['auto', 'scroll', 'overlay']);

/**
 * The scroll container the post lives in — Mattermost's post list, not the
 * window. It becomes the IntersectionObserver root so that `rootBounds` is the
 * area a post can really occupy.
 *
 * Measured in a live Mattermost Desktop 6.3.0 window: the post list is 492px
 * tall inside a 760px window, i.e. 65% of it. With the default (viewport) root
 * the visible slice of a post can never reach 75% of `rootBounds`, so the
 * tall-post branch below was unreachable and a post taller than
 * `listHeight / 0.75` (~656px there) could never be reported as read at all.
 *
 * Selection is by computed `overflow-y` ALONE, deliberately not by whether the
 * container currently overflows. `scrollHeight > clientHeight` is a property of
 * the content at one instant: a channel with few posts, or one whose images and
 * attachments have not loaded yet, does not overflow at mount time. The root is
 * chosen once when the effect runs, so a geometry-dependent choice would pin the
 * observer to the window for the whole lifetime of that mount and silently bring
 * the unreachable tall-post branch back. `overflow-y` is set by the virtualized
 * list from its first render and does not change with content.
 *
 * Picking the nearest such ancestor is safe here — measured chain from `.post`
 * upwards in the live client:
 *
 *     1..3  unnamed wrappers          overflow-y: visible
 *     4     div.post-list__dynamic    overflow-y: auto     <- the real scroller
 *     6     #postListContent          overflow-y: hidden
 *     13    #post-list                overflow-y: hidden
 *     19..21 .main-wrapper, #root, body  overflow-y: hidden
 *
 * The post list is the only auto/scroll element in the chain; the `hidden`
 * wrappers sit above it and clip without scrolling, so they are not roots.
 *
 * Returns null when no such ancestor exists, which keeps the viewport as the
 * root exactly as before.
 */
export function resolveScrollRoot(element: Element): Element | null {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
        return null;
    }
    let node = element.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
        if (SCROLLABLE_OVERFLOW_Y.has(getComputedStyle(node).overflowY)) {
            return node;
        }
        node = node.parentElement;
    }
    return null;
}

/**
 * A post counts as visible when either:
 *   - at least `threshold` of its area is inside the root, or
 *   - it is taller than the root and its visible slice fills at least
 *     `threshold` of the root height (a tall post that spans the whole visible
 *     area is genuinely on screen even though its ratio never reaches the
 *     threshold, because much of it is necessarily above or below the fold).
 *
 * `rootBounds` is the observer root — the post list when one was resolved, the
 * viewport otherwise.
 */
export function isSufficientlyVisible(entry: IntersectionObserverEntryLike, threshold: number): boolean {
    if (entry.intersectionRatio >= threshold) {
        return true;
    }

    const rootHeight = entry.rootBounds?.height ?? 0;
    const intersectionHeight = entry.intersectionRect?.height ?? 0;
    if (rootHeight > 0 && intersectionHeight >= rootHeight * threshold) {
        return true;
    }

    return false;
}
