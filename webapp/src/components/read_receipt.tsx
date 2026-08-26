import React, {useEffect} from 'react';

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

function getPostElement(postId: string): HTMLElement | null {
    const host = document.querySelector(`.read-receipt-ticks-portal-host[data-post-id="${postId}"]`);
    if (host) {
        return host.closest('.post') as HTMLElement | null;
    }
    const el = document.getElementById(`post_${postId}`);
    return el;
}

interface ReadReceiptProps {
    postId: string;
}

export const ReadReceipt: React.FC<ReadReceiptProps> = ({postId}) => {
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

        const initial = getPostContext(store.getState(), postId);
        if (!initial || initial.isOwn || !initial.isDM) {
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

        const postEl = getPostElement(postId);
        if (!postEl) {
            return;
        }

        const root = resolveScrollRoot(postEl);

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const visible = isSufficientlyVisible(entry, VISIBILITY_THRESHOLD);
                sufficientlyVisible = visible;
                if (!visible || !tracker.isActive() || status === 'pending') {
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
        }, {threshold: VISIBILITY_THRESHOLDS, root});

        observer.observe(postEl);

        const onVisibilityChange = (visibility: VisibilityState) => {
            const active = visibility.isVisible && visibility.isFocused && !visibility.isIdle;
            if (!active) {
                clearDwell();
                if (status !== 'sent') {
                    clearRetry();
                }
                return;
            }
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
    }, [postId, store, isDM]);

    if (!isOwn) {
        return null;
    }

    if (!readAt) {
        return null;
    }

    const time = formatReadTime(readAt, locale);

    return (
        <div
            className='read-receipt-ticks-attachment'
            title={t(locale, 'readAt', {time})}
        >
            <StatusTicks label={t(locale, 'read')} />
        </div>
    );
};

export default ReadReceipt;
