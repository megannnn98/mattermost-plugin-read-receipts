import React, {useEffect, useRef, useState} from 'react';

import {sendReadReceipt} from '../actions';
import {getStore} from '../store_ref';
import {getVisibilityTracker} from '../visibility';
import {isPostRead, selectPostReadAt} from '../selectors';

interface ReadReceiptProps {
    postId: string;
}

export const ReadReceipt: React.FC<ReadReceiptProps> = ({postId}) => {
    const sentinelRef = useRef<HTMLSpanElement>(null);
    const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

        const state = store.getState();
        const post = state.entities?.posts?.posts?.[postId];
        if (!post) {
            return;
        }

        const isOwn = post.user_id === state.entities?.users?.currentUserId;
        const channelId = post.channel_id;

        if (isOwn) {
            return;
        }

        const tracker = getVisibilityTracker();

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting && tracker.isActive()) {
                        if (!hasReportedRef.current && !dwellTimerRef.current) {
                            dwellTimerRef.current = setTimeout(() => {
                                if (tracker.isActive() && !hasReportedRef.current) {
                                    hasReportedRef.current = true;
                                    sendReadReceipt(store, channelId, postId, post.create_at);
                                }
                                dwellTimerRef.current = null;
                            }, 1000);
                        }
                    } else {
                        if (dwellTimerRef.current) {
                            clearTimeout(dwellTimerRef.current);
                            dwellTimerRef.current = null;
                        }
                    }
                }
            },
            {threshold: 0.75},
        );

        if (sentinelRef.current) {
            observer.observe(sentinelRef.current);
        }

        const unsubTracker = tracker.subscribe((state) => {
            if (!state.isVisible || !state.isFocused || state.isIdle) {
                if (dwellTimerRef.current) {
                    clearTimeout(dwellTimerRef.current);
                    dwellTimerRef.current = null;
                }
            }
        });

        return () => {
            observer.disconnect();
            unsubTracker();
            if (dwellTimerRef.current) {
                clearTimeout(dwellTimerRef.current);
            }
        };
    }, [postId, store]);

    if (!store) {
        return null;
    }

    const state = store.getState();
    const post = state.entities?.posts?.posts?.[postId];
    if (!post) {
        return null;
    }

    const isOwn = post.user_id === state.entities?.users?.currentUserId;
    const channelId = post.channel_id;

    if (!isOwn) {
        return <span ref={sentinelRef} style={{height: 0, width: 0, display: 'block'}} aria-hidden="true" />;
    }

    const read = isPostRead(state, postId, post.create_at, channelId);
    if (!read) {
        return null;
    }

    const readAt = selectPostReadAt(state, postId, post.create_at, channelId);
    if (!readAt) {
        return null;
    }

    const date = new Date(readAt);
    const time = date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

    return (
        <div
            className="read-receipt-indicator"
            title={`Прочитано в ${time}`}
        >
            <span style={{color: 'var(--center-channel-color-rgb)', opacity: 0.56, fontSize: '0.75rem'}}>
                ✓✓ Прочитано {time}
            </span>
        </div>
    );
};

export default ReadReceipt;
