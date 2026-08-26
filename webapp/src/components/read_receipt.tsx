import React, {useEffect, useRef} from 'react';

import {sendReadReceipt} from '../actions';
import {getStore} from '../store_ref';
import {getVisibilityTracker, VisibilityState} from '../visibility';
import {formatReadTime, getLocaleFromState, t, SupportedLocale} from '../i18n';
import {usePluginSelector} from '../hooks';
import {getPostContext, shouldReportRead} from '../gating';
import {selectPostReadAt} from '../selectors';
import {GlobalState} from '../types';
import {StatusTicks} from './status_ticks';
import {
    isSufficientlyVisible,
    resolveObservedElement,
    resolveScrollRoot,
    VISIBILITY_THRESHOLD,
    VISIBILITY_THRESHOLDS,
} from '../visibility_ratio';

const DWELL_MS = 1000;
const RETRY_BACKOFF_MS = 5000;

type SendStatus = 'idle' | 'pending' | 'sent';

const isOwnPost = (state: GlobalState, postId: string): boolean => {
    const post = state?.entities?.posts?.posts?.[postId];
    return post ? post.user_id === state?.entities?.users?.currentUserId : false;
};

const isDMChannel = (state: GlobalState, postId: string): boolean => {
    const post = state?.entities?.posts?.posts?.[postId];
    const channel = post && state?.entities?.channels?.channels?.[post.channel_id];
    return channel?.type === 'D';
};

const selectReadAt = (state: GlobalState, postId: string): number | null => {
    const ctx = getPostContext(state, postId);
    if (!ctx || !ctx.isOwn) {
        return null;
    }
    return selectPostReadAt(state, postId, ctx.createAt, ctx.channelId);
};

const isEqualDisplay = (
    a: {isOwn: boolean; isDM: boolean; readAt: number | null},
    b: {isOwn: boolean; isDM: boolean; readAt: number | null},
): boolean => a.isOwn === b.isOwn && a.isDM === b.isDM && a.readAt === b.readAt;

interface ReadReceiptProps {
    postId: string;
}

export const ReadReceipt: React.FC<ReadReceiptProps> = ({postId}) => {
    const sentinelRef = useRef<HTMLSpanElement>(null);

    const store = getStore();

    const {isOwn, isDM, readAt} = usePluginSelector(
        store,
        (state) => ({
            isOwn: isOwnPost(state, postId),
            isDM: isDMChannel(state, postId),
            readAt: selectReadAt(state, postId),
        }),
        isEqualDisplay,
    );
    const locale = usePluginSelector<SupportedLocale>(store, (state) => getLocaleFromState(state));

    useEffect(() => {
        let disposed = false;
        let status: SendStatus = 'idle';
        let dwellTimer: ReturnType<typeof setTimeout> | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let sufficientlyVisible = false;
        if (!store) {
            return;
        }

        const tracker = getVisibilityTracker();

        // Own posts never auto-report; their display is driven purely by the
        // received receipts/watermark state selectors above.
        const initial = getPostContext(store.getState(), postId);
        if (!initial || initial.isOwn) {
            return;
        }

        const clearDwell = () => {
            if (dwellTimer) {
                clearTimeout(dwellTimer);
                dwellTimer = null;
            }
        };

        const clearRetry = () => {
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
        };

        const canReport = () => status !== 'sent' && status !== 'pending';

        const attemptSend = () => {
            if (!canReport()) {
                return;
            }
            if (!tracker.isActive()) {
                return;
            }
            const state = store.getState();
            if (!shouldReportRead(state, postId)) {
                return;
            }
            const current = getPostContext(state, postId);
            if (!current) {
                return;
            }

            status = 'pending';
            sendReadReceipt(current.channelId, postId, current.createAt).then((ok) => {
                if (disposed) {
                    return;
                }
                if (ok) {
                    status = 'sent';
                    return;
                }
                // The request failed — go back to idle so a later attempt can
                // retry, and schedule one automatically after a backoff.
                status = 'idle';
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    if (canReport() && sufficientlyVisible && tracker.isActive()) {
                        attemptSend();
                    }
                }, RETRY_BACKOFF_MS);
            });
        };

        const startDwell = () => {
            if (!canReport() || dwellTimer) {
                return;
            }
            dwellTimer = setTimeout(() => {
                dwellTimer = null;
                attemptSend();
            }, DWELL_MS);
        };

        // Resolve the observed element and its scrolling root before creating the
        // observer: thresholds are relative to the root, and Mattermost's post
        // list is only ~65% of the window, so measuring against the window makes
        // the tall-post branch unreachable.
        const observed = sentinelRef.current ? resolveObservedElement(sentinelRef.current) : null;
        const observedRoot = observed ? resolveScrollRoot(observed) : null;

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const visible = isSufficientlyVisible(entry, VISIBILITY_THRESHOLD);
                sufficientlyVisible = visible;
                if (!visible || !tracker.isActive() || status === 'pending') {
                    // Leaving view, an inactive window, or a request in flight
                    // cancels any pending dwell/backoff (unless already sent).
                    clearDwell();
                    if (status !== 'sent') {
                        clearRetry();
                    }
                    continue;
                }
                if (status === 'idle') {
                    startDwell();
                }
            }
        }, {threshold: VISIBILITY_THRESHOLDS, root: observedRoot});

        if (observed) {
            observer.observe(observed);
        }

        const onVisibilityChange = (visibility: VisibilityState) => {
            const active = visibility.isVisible && visibility.isFocused && !visibility.isIdle;
            if (!active) {
                // Blur/hidden/idle cancels any pending dwell or retry backoff.
                clearDwell();
                if (status !== 'sent') {
                    clearRetry();
                }
                return;
            }
            // The window became active again (focus/visibility/idle). No new
            // IntersectionObserver callback fires for a post that is already
            // visible, so restart the dwell from the last known visibility.
            if (sufficientlyVisible && status === 'idle') {
                startDwell();
            }
        };

        const unsubTracker = tracker.subscribe(onVisibilityChange);

        return () => {
            disposed = true;
            observer.disconnect();
            unsubTracker();
            clearDwell();
            clearRetry();
            sufficientlyVisible = false;
        };
        // `isDM` is a dependency on purpose: while the channel entity is not in
        // the store yet the component renders nothing, so there is no sentinel
        // for the observer to attach to. Re-running the effect once isDM flips
        // to true is what actually binds the observer to the mounted sentinel.
    }, [postId, store, isDM]);

    if (!isDM) {
        return null;
    }

    if (!isOwn) {
        return (
            <span
                ref={sentinelRef}
                style={{height: 0, width: 0, display: 'block'}}
                aria-hidden='true'
            />
        );
    }

    if (!readAt) {
        return null;
    }

    const time = formatReadTime(readAt, locale);

    return (
        <div
            className='read-receipt-indicator'
            title={t(locale, 'readAt', {time})}
        >
            <StatusTicks label={t(locale, 'read')} />
        </div>
    );
};

export default ReadReceipt;
