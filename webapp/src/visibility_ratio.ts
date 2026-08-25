// Pure visibility helpers for deciding whether a post is "seen enough" to
// count as read. Kept dependency-free so they are directly unit-testable.

export const VISIBILITY_THRESHOLD = 0.75;

export interface RectLike {
    height: number;
}

export interface IntersectionObserverEntryLike {
    intersectionRatio: number;
    intersectionRect: RectLike;
    rootBounds: RectLike | null;
}

/**
 * The component observes a 1x1 sentinel span. A post taller than the viewport
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
 * A post counts as visible when either:
 *   - at least `threshold` of its area is inside the viewport, or
 *   - it is taller than the viewport and its visible slice fills at least
 *     `threshold` of the viewport height (a tall post that spans the whole
 *     screen is genuinely on-screen even though its ratio never reaches the
 *     threshold, because much of it is necessarily above or below the fold).
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
