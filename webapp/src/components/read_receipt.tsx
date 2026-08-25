import React, {useEffect, useRef} from 'react';

import {sendReadReceipt} from '../actions';
import {getStore} from '../store_ref';
import {getVisibilityTracker, VisibilityState} from '../visibility';
import {formatReadTime, getLocaleFromState, t, SupportedLocale} from '../i18n';
import {usePluginSelector} from '../hooks';
import {getPostContext, shouldReportRead} from '../gating';
import {selectPostReadAt} from '../selectors';
import {GlobalState} from '../types';
import {
    isSufficientlyVisible,
    resolveObservedElement,
    VISIBILITY_THRESHOLD,
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
    const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSufficientlyVisibleRef = useRef(false);
    const statusRef = useRef<SendStatus>('idle');

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
            if (dwellTimerRef.current) {
                clearTimeout(dwellTimerRef.current);
                dwellTimerRef.current = null;
            }
        };

        const clearRetry = () => {
            if (retryTimerRef.current) {
                clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }
        };

        const canReport = () => statusRef.current !== 'sent' && statusRef.current !== 'pending';

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

            statusRef.current = 'pending';
            sendReadReceipt(current.channelId, postId, current.createAt).then((ok) => {
                if (ok) {
                    statusRef.current = 'sent';
                    return;
                }
                // The request failed — go back to idle so a later attempt can
                // retry, and schedule one automatically after a backoff.
                statusRef.current = 'idle';
                retryTimerRef.current = setTimeout(() => {
                    retryTimerRef.current = null;
                    if (canReport() && lastSufficientlyVisibleRef.current && tracker.isActive()) {
                        attemptSend();
                    }
                }, RETRY_BACKOFF_MS);
            });
        };

        const startDwell = () => {
            if (!canReport() || dwellTimerRef.current) {
                return;
            }
            dwellTimerRef.current = setTimeout(() => {
                dwellTimerRef.current = null;
                attemptSend();
            }, DWELL_MS);
        };

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const visible = isSufficientlyVisible(entry, VISIBILITY_THRESHOLD);
                lastSufficientlyVisibleRef.current = visible;
                if (!visible || !tracker.isActive() || statusRef.current === 'pending') {
                    // Leaving view, an inactive window, or a request in flight
                    // cancels any pending dwell/backoff (unless already sent).
                    clearDwell();
                    if (statusRef.current !== 'sent') {
                        clearRetry();
                    }
                    continue;
                }
                if (statusRef.current === 'idle') {
                    startDwell();
                }
            }
        }, {threshold: [0, VISIBILITY_THRESHOLD]});

        if (sentinelRef.current) {
            observer.observe(resolveObservedElement(sentinelRef.current));
        }

        const onVisibilityChange = (visibility: VisibilityState) => {
            const active = visibility.isVisible && visibility.isFocused && !visibility.isIdle;
            if (!active) {
                // Blur/hidden/idle cancels any pending dwell or retry backoff.
                clearDwell();
                if (statusRef.current !== 'sent') {
                    clearRetry();
                }
                return;
            }
            // The window became active again (focus/visibility/idle). No new
            // IntersectionObserver callback fires for a post that is already
            // visible, so restart the dwell from the last known visibility.
            if (lastSufficientlyVisibleRef.current && statusRef.current === 'idle') {
                startDwell();
            }
        };

        const unsubTracker = tracker.subscribe(onVisibilityChange);

        return () => {
            observer.disconnect();
            unsubTracker();
            clearDwell();
            clearRetry();
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
            <span
                style={{
                    color: 'var(--center-channel-color-rgb)',
                    opacity: 0.56,
                    fontSize: '0.75rem',
                }}
            >
                {`✓✓ ${t(locale, 'read')} ${time}`}
            </span>
        </div>
    );
};

export default ReadReceipt;
