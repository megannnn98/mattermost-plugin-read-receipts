import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import {loadPostReaders, sendReadReceipt} from '../actions';
import {PLUGIN_ID} from '../client';
import {getStore} from '../store_ref';
import {getVisibilityTracker, VisibilityState} from '../visibility';
import {formatReadTime, getLocaleFromState, t, SupportedLocale} from '../i18n';
import {usePluginSelector} from '../hooks';
import {getPostContext, shouldReportRead} from '../gating';
import {selectPostReadCount, selectSingleReaderReadAt, selectPluginState} from '../selectors';
import {createInlineMount} from '../inline_mount';
import {ReadersPopover, ReadersStatus} from './readers_popover';
import {GlobalState} from '../types';
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

const isEligibleChannel = (state: GlobalState, postId: string): boolean => Boolean(getPostContext(state, postId)?.isEligibleChannel);

const selectReadAt = (state: GlobalState, postId: string): number | null => {
    const ctx = getPostContext(state, postId);
    if (!ctx || !ctx.isOwn) {
        return null;
    }
    return selectSingleReaderReadAt(state, postId, ctx.createAt, ctx.channelId);
};

const isEqualDisplay = (
    a: {isOwn: boolean; isDM: boolean; eligible: boolean; readAt: number | null; count: number; readers: unknown},
    b: {isOwn: boolean; isDM: boolean; eligible: boolean; readAt: number | null; count: number; readers: unknown},
): boolean => a.isOwn === b.isOwn && a.isDM === b.isDM && a.eligible === b.eligible && a.readAt === b.readAt && a.count === b.count && a.readers === b.readers;

interface ReadReceiptProps {
    postId: string;
}

function selectReadCount(state: GlobalState, postId: string): number {
    const context = getPostContext(state, postId);
    const post = state.entities?.posts?.posts?.[postId];
    if (!context || !post) {
        return 0;
    }
    return selectPostReadCount(state, postId, context.createAt, context.channelId, post.user_id);
}

export const ReadReceipt: React.FC<ReadReceiptProps> = ({postId}) => {
    const sentinelRef = useRef<HTMLSpanElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [inlineTarget, setInlineTarget] = useState<HTMLElement | null>(null);
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [readersFailed, setReadersFailed] = useState(false);

    const store = getStore();

    const {isOwn, isDM, eligible, readAt, count} = usePluginSelector(
        store,
        (state) => ({
            isOwn: isOwnPost(state, postId),
            isDM: isDMChannel(state, postId),
            eligible: isEligibleChannel(state, postId),
            readAt: selectReadAt(state, postId),
            count: selectReadCount(state, postId),
            readers: selectPluginState(state).readers[postId],
        }),
        isEqualDisplay,
    );
    const locale = usePluginSelector<SupportedLocale>(store, (state) => getLocaleFromState(state));

    useEffect(() => {
        if (!isOwn || count === 0 || !sentinelRef.current) return undefined;
        const mount = createInlineMount(sentinelRef.current);
        setInlineTarget(mount?.target ?? null);
        return () => { mount?.dispose(); setInlineTarget(null); };
    }, [isOwn, count]);

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
        // `eligible` is a dependency on purpose: while the channel entity is not in
        // the store yet the component renders nothing, so there is no sentinel
        // for the observer to attach to. Re-running the effect once eligibility flips
        // to true is what actually binds the observer to the mounted sentinel.
    }, [postId, store, eligible]);

    if (!eligible) {
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

    if (count === 0) {
        return null;
    }

    const state = store?.getState();
    const cachedReaders = state ? selectPluginState(state).readers[postId] : undefined;
    const profiles = state ? {...(state.entities?.users?.profiles ?? {}), ...selectPluginState(state).profiles} : {};
    const openPopover = () => {
        if (!cachedReaders && store) {
            setReadersFailed(false);
            loadPostReaders(store, postId).catch((error) => {
                console.error(`[${PLUGIN_ID}] Failed to load post readers:`, error);
                setReadersFailed(true);
            });
        }
        setPopoverOpen(true);
    };

    // The popover is rendered as soon as it is opened, before the readers arrive.
    // Waiting for the data would leave a failed request with an open flag and no
    // close handlers mounted — a popover that can never be dismissed.
    let readersStatus: ReadersStatus = 'ready';
    if (!cachedReaders) {
        readersStatus = readersFailed ? 'error' : 'loading';
    }

    const indicator = isDM ? (
        <span title={readAt === null ? undefined : t(locale, 'readAt', {time: formatReadTime(readAt, locale)})}>
            {'✓✓'}
        </span>
    ) : (
        <button
            ref={buttonRef}
            type='button'
            onClick={openPopover}
            aria-label={t(locale, 'readCount', {count: String(count)})}
            style={{border: 0, background: 'none', padding: 0, color: 'inherit'}}
        >
            {`✓✓ ${count}`}
        </button>
    );

    const portal = (
        <>
            <span style={{opacity: 0.56, fontSize: '0.75rem', marginLeft: 4, whiteSpace: 'nowrap', verticalAlign: 'baseline'}}>
                {indicator}
            </span>
            {popoverOpen && buttonRef.current && (
                <ReadersPopover
                    anchor={buttonRef.current}
                    readers={cachedReaders?.list ?? []}
                    status={readersStatus}
                    truncated={cachedReaders?.truncated ?? false}
                    profiles={profiles}
                    locale={locale}
                    onClose={() => setPopoverOpen(false)}
                />
            )}
        </>
    );

    return (
        <span ref={sentinelRef} style={{display: 'contents'}}>
            {inlineTarget && createPortal(portal, inlineTarget)}
        </span>
    );
};

export default ReadReceipt;
