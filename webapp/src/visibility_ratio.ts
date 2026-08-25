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

/**
 * The scrollable ancestor the post is actually clipped by — Mattermost's post
 * list, not the window. It becomes the IntersectionObserver root so that
 * `rootBounds` is the area a post can really occupy.
 *
 * Measured in a live Mattermost Desktop 6.3.0 window: the post list is 492px
 * tall inside a 760px window, i.e. 65% of it. With the default (viewport) root
 * the visible slice of a post can never reach 75% of `rootBounds`, so the
 * tall-post branch below was unreachable and a post taller than
 * `listHeight / 0.75` (~656px there) could never be reported as read at all.
 *
 * Returns null when no scrollable ancestor exists, which keeps the viewport as
 * the root exactly as before.
 */
export function resolveScrollRoot(element: Element): Element | null {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
        return null;
    }
    let node = element.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
        const overflowY = getComputedStyle(node).overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
            node.scrollHeight > node.clientHeight) {
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
