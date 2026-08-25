import React, {useEffect, useRef, useState} from 'react';

import {sendReadReceipt} from '../actions';
import {getStore} from '../store_ref';
import {getVisibilityTracker, VisibilityState} from '../visibility';
import {isPostRead, selectPostReadAt} from '../selectors';
import {getPostContext, shouldReportRead} from '../gating';
import {formatReadTime, getLocaleFromState, t} from '../i18n';
import {
    isSufficientlyVisible,
    resolveObservedElement,
    VISIBILITY_THRESHOLD,
} from '../visibility_ratio';

const DWELL_MS = 1000;
const RETRY_BACKOFF_MS = 5000;

type SendStatus = 'idle' | 'pending' | 'sent';

interface ReadReceiptProps {
    postId: string;
}

export const ReadReceipt: React.FC<ReadReceiptProps> = ({postId}) => {
    const sentinelRef = useRef<HTMLSpanElement>(null);
    const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSufficientlyVisibleRef = useRef(false);
    const statusRef = useRef<SendStatus>('idle');
    const [, forceUpdate] = useState(0);

    const store = getStore();

    useEffect(() => {
        if (!store) {
            return;
        }

        const unsubscribe = store.subscribe(() => {
            forceUpdate((n) => n + 1);
        });
        return () => unsubscribe();
    }, [store]);

    useEffect(() => {
        if (!store) {
            return;
        }

        const ctx = getPostContext(store.getState(), postId);
        if (!ctx || ctx.isOwn) {
            return;
        }

        const tracker = getVisibilityTracker();

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
    }, [postId, store]);

    if (!store) {
        return null;
    }

    const state = store.getState();
    const ctx = getPostContext(state, postId);
    if (!ctx || !ctx.isDM) {
        return null;
    }

    if (!ctx.isOwn) {
        return (
            <span
                ref={sentinelRef}
                style={{height: 0, width: 0, display: 'block'}}
                aria-hidden='true'
            />
        );
    }

    if (!isPostRead(state, postId, ctx.createAt, ctx.channelId)) {
        return null;
    }

    const readAt = selectPostReadAt(state, postId, ctx.createAt, ctx.channelId);
    if (!readAt) {
        return null;
    }

    const locale = getLocaleFromState(state);
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
