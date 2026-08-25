import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import {loadPostReaders, sendReadReceipt} from '../actions';
import {PLUGIN_ID} from '../client';
import {getStore} from '../store_ref';
import {getVisibilityTracker, VisibilityState} from '../visibility';
import {formatReadTime, getLocaleFromState, t, SupportedLocale} from '../i18n';
import {usePluginSelector} from '../hooks';
import {getPostContext, shouldReportRead} from '../gating';
import {selectPostReadCount, selectSingleReaderReadAt, selectPluginState} from '../selectors';
import {createInlineMount, InlineMount} from '../inline_mount';
import {ReadersPopover, ReadersStatus} from './readers_popover';
import {StatusTicks} from './status_ticks';
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

/**
 * A post counts as delivered once the server has accepted it — which is exactly
 * what the single checkmark means in the messengers this indicator is modelled
 * on. Mattermost has no per-device delivery signal at all, and the server-side
 * `MessageHasBeenPosted` hook fires on that same acceptance, so storing a
 * "delivered" flag would spend a KV key per post to record what the client can
 * already see: the post exists and is neither pending nor failed.
 */
const isDelivered = (state: GlobalState, postId: string): boolean => {
    const post = state?.entities?.posts?.posts?.[postId];
    if (!post) {
        return false;
    }
    const pending = Boolean(post.pending_post_id) && post.pending_post_id === post.id;
    return !pending && post.state !== 'FAILED';
};

/**
 * A key that changes exactly when Mattermost rebuilds the rendered message.
 *
 * The indicator lives in a node appended into React-owned DOM, so an edit or a
 * reaction re-renders the message and throws that node away — measured in a real
 * client, where the checkmark disappeared until a full reload. This component is
 * a sibling of the message, so nothing would tell it to re-attach; selecting the
 * fields that drive that re-render is what makes it notice.
 */
const selectRenderKey = (state: GlobalState, postId: string): string => {
    const post = state?.entities?.posts?.posts?.[postId];
    const reactions = (state?.entities?.posts as {reactions?: Record<string, Record<string, unknown>>} | undefined)?.reactions?.[postId];
    if (!post) {
        return '';
    }
    return `${post.update_at ?? 0}|${post.edit_at ?? 0}|${reactions ? Object.keys(reactions).length : 0}`;
};

const selectReadAt = (state: GlobalState, postId: string): number | null => {
    const ctx = getPostContext(state, postId);
    if (!ctx || !ctx.isOwn) {
        return null;
    }
    return selectSingleReaderReadAt(state, postId, ctx.createAt, ctx.channelId);
};

type Display = {
    isOwn: boolean;
    isDM: boolean;
    eligible: boolean;
    delivered: boolean;
    readAt: number | null;
    count: number;
    renderKey: string;
    readers: unknown;
};

const isEqualDisplay = (a: Display, b: Display): boolean =>
    a.isOwn === b.isOwn &&
    a.isDM === b.isDM &&
    a.eligible === b.eligible &&
    a.delivered === b.delivered &&
    a.readAt === b.readAt &&
    a.count === b.count &&
    a.renderKey === b.renderKey &&
    a.readers === b.readers;

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
    const mountRef = useRef<InlineMount | null>(null);
    // A callback ref, not a plain one: the popover needs the anchor *during*
    // render, and a plain ref read there is stale for one render after the
    // portal is re-created — the click that opened the popover then rendered
    // nothing at all. Storing the node in state guarantees a render with it.
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    const anchorRef = useCallback((node: HTMLButtonElement | null) => setAnchor(node), []);
    const [inlineTarget, setInlineTarget] = useState<HTMLElement | null>(null);
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [readersFailed, setReadersFailed] = useState(false);
    const [remounts, setRemounts] = useState(0);

    const store = getStore();

    const {isOwn, isDM, eligible, delivered, readAt, count, renderKey} = usePluginSelector(
        store,
        (state) => ({
            isOwn: isOwnPost(state, postId),
            isDM: isDMChannel(state, postId),
            eligible: isEligibleChannel(state, postId),
            delivered: isDelivered(state, postId),
            readAt: selectReadAt(state, postId),
            count: selectReadCount(state, postId),
            renderKey: selectRenderKey(state, postId),
            readers: selectPluginState(state).readers[postId],
        }),
        isEqualDisplay,
    );
    const locale = usePluginSelector<SupportedLocale>(store, (state) => getLocaleFromState(state));

    useEffect(() => {
        if (!isOwn || !delivered || !sentinelRef.current) {
            return undefined;
        }
        const mount = createInlineMount(sentinelRef.current);
        mountRef.current = mount;
        setInlineTarget(mount?.target ?? null);
        return () => {
            mount?.dispose();
            mountRef.current = null;
            setInlineTarget(null);
        };
        // `renderKey` and `remounts` are dependencies on purpose: the first
        // re-runs the mount when Mattermost rebuilt the message around our node,
        // the second when the check below found the node already detached.
    }, [isOwn, delivered, renderKey, remounts]);

    // Runs after every render and costs one `isConnected` read. A detached target
    // means React dropped our node while rendering something else; bumping the
    // counter re-runs the mount above. When the node is still attached this is a
    // no-op, so there is no render loop and no observer or polling involved.
    //
    // It reads the ref, not the state: in the commit where the mount above just
    // re-attached, the rendered `inlineTarget` is still the previous, detached
    // node, and comparing against it would bump the counter forever.
    useEffect(() => {
        if (mountRef.current && !mountRef.current.target.isConnected) {
            setRemounts((n) => n + 1);
        }
    });

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

    if (!delivered) {
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

    let indicator;
    if (count === 0) {
        // Accepted by the server, nobody has read it yet.
        indicator = (
            <span title={t(locale, 'delivered')}>
                <StatusTicks
                    status='delivered'
                    label={t(locale, 'delivered')}
                />
            </span>
        );
    } else if (isDM) {
        indicator = (
            <span title={readAt === null ? t(locale, 'read') : t(locale, 'readAt', {time: formatReadTime(readAt, locale)})}>
                <StatusTicks
                    status='read'
                    label={t(locale, 'read')}
                />
            </span>
        );
    } else {
        indicator = (
            <button
                ref={anchorRef}
                type='button'
                onClick={openPopover}
                aria-label={t(locale, 'readCount', {count: String(count)})}
                // inline-flex, not per-child vertical-align: the wrapper collapses
                // its line box to keep the post height, and aligning children
                // against a collapsed line box drops the count like a subscript.
                // The size is in px on purpose — Mattermost's root font-size is
                // 10px, so `0.75rem` here is 7.5px and unreadable.
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    verticalAlign: 'text-bottom',
                    border: 0,
                    background: 'none',
                    padding: 0,
                    color: 'inherit',
                    cursor: 'pointer',
                    lineHeight: 1,
                }}
            >
                <StatusTicks
                    status='read'
                    label={t(locale, 'read')}
                />
                <span style={{fontSize: 11, color: 'var(--center-channel-color, #3f4350)', opacity: 0.72}}>{count}</span>
            </button>
        );
    }

    const portal = (
        <>
            {/*
              * `lineHeight: 0` is load-bearing, not cosmetic. A smaller font with
              * a normal line-height still builds an inline box whose half-leading
              * hangs below the paragraph's strut, and measuring a real client
              * showed the post growing by 2px the moment the indicator appeared.
              * A zero line-height collapses that box, so the line stays exactly
              * as tall as the paragraph while the glyph still paints.
              */}
            <span
                style={{
                    opacity: 0.56,
                    fontSize: '0.75rem',
                    lineHeight: 0,
                    marginLeft: 4,
                    whiteSpace: 'nowrap',
                    verticalAlign: 'baseline',
                }}
            >
                {indicator}
            </span>
            {popoverOpen && anchor && (
                <ReadersPopover
                    anchor={anchor}
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
