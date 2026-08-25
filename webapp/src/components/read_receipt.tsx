import React, {useEffect, useRef, useState} from 'react';

import {sendReadReceipt} from '../actions';
import {getStore} from '../store_ref';
import {getVisibilityTracker} from '../visibility';
import {isPostRead, selectPostReadAt} from '../selectors';
import {getPostContext, shouldReportRead} from '../gating';
import {formatReadTime, getLocaleFromState, t} from '../i18n';

const DWELL_MS = 1000;
const VISIBILITY_THRESHOLD = 0.75;

interface ReadReceiptProps {
    postId: string;
}

export const ReadReceipt: React.FC<ReadReceiptProps> = ({postId}) => {
    const sentinelRef = useRef<HTMLSpanElement>(null);
    const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastIntersectingRef = useRef(false);
    const hasReportedRef = useRef(false);
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

        const startDwell = () => {
            if (hasReportedRef.current || dwellTimerRef.current) {
                return;
            }
            dwellTimerRef.current = setTimeout(() => {
                dwellTimerRef.current = null;

                // Re-checked on fire: the channel may have been switched
                // away, or the window blurred, while the timer was pending.
                if (hasReportedRef.current || !tracker.isActive()) {
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
                hasReportedRef.current = true;
                void sendReadReceipt(current.channelId, postId, current.createAt);
            }, DWELL_MS);
        };

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    lastIntersectingRef.current = entry.isIntersecting;
                    if (!entry.isIntersecting || !tracker.isActive()) {
                        clearDwell();
                        continue;
                    }
                    startDwell();
                }
            },
            {threshold: VISIBILITY_THRESHOLD},
        );

        if (sentinelRef.current) {
            observer.observe(sentinelRef.current);
        }

        const unsubTracker = tracker.subscribe((visibility) => {
            if (!visibility.isVisible || !visibility.isFocused || visibility.isIdle) {
                clearDwell();
                return;
            }
            // The window became active again (focus/visibility/idle). No new
            // IntersectionObserver callback fires for a post that is already
            // visible, so restart the dwell from the last known intersection.
            if (lastIntersectingRef.current) {
                startDwell();
            }
        });

        return () => {
            observer.disconnect();
            unsubTracker();
            clearDwell();
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
