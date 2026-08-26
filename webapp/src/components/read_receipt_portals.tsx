import React, {useEffect, useReducer, useRef} from 'react';
import {createPortal} from 'react-dom';

import ReadReceipt from './read_receipt';
import {getStore} from '../store_ref';

const PORTAL_RETRY_MS = [250, 1000, 3000, 5000];

const portalHosts = new Map<string, HTMLElement>();

// Cached own/incoming DM post id lists for the current channel. Both are
// rebuilt in one pass when any of the cache keys change — posts, channels,
// the current user, or the current channel. Returning the cached array by
// reference is safe because every consumer only reads it (syncPortalHosts,
// cleanupStaleHosts, some, map).
//
// Scoping to the current channel keeps the mounted component set bounded:
// without it every incoming DM post ever seen would mount a ReadReceipt (and
// up to four attach-retry timers each), even if the user is in a different
// channel right now. Posts in other DMs get picked up on channel switch, when
// the identity key changes and the cache rebuilds.
//
// A separate hasDmChanges check in the store subscription (checking whether
// the changed posts are actually in DM channels) was considered and rejected:
// the identity cache below makes noop notifications two pointer comparisons,
// and a real change always costs one traversal regardless. hasDmChanges would
// save that traversal only when the change is in a non-DM channel — real but
// small, not worth the second invalidation mechanism.
let cachedPostsRef: unknown = null;
let cachedChannelsRef: unknown = null;
let cachedUserId: string | null = null;
let cachedCurrentChannelId: string | null = null;
let cachedOwn: string[] = [];
let cachedIncoming: string[] = [];

function collectDmPostIds(mine: boolean): string[] {
    const store = getStore();

    // No store — invalidate cache and return empty. Do not hand back stale
    // data from a previous session: uninitialize calls setStore(null) and the
    // old posts reference would otherwise keep a large object alive.
    if (!store) {
        cachedPostsRef = null;
        cachedChannelsRef = null;
        cachedUserId = null;
        cachedCurrentChannelId = null;
        cachedOwn = [];
        cachedIncoming = [];
        return [];
    }

    const state = store.getState();
    const posts = state?.entities?.posts?.posts ?? {};
    const channels = state?.entities?.channels?.channels ?? {};
    const userId = state?.entities?.users?.currentUserId ?? null;
    const currentChannelId = state?.entities?.channels?.currentChannelId ?? null;

    // No user yet — do not classify posts as own or incoming. Without a user id
    // every post would fall into the incoming bucket, mounting components (and
    // their attach-retry timers) for posts whose ownership is unknown.
    if (!userId) {
        cachedPostsRef = null;
        cachedChannelsRef = null;
        cachedUserId = null;
        cachedCurrentChannelId = null;
        cachedOwn = [];
        cachedIncoming = [];
        return [];
    }

    if (posts === cachedPostsRef && channels === cachedChannelsRef &&
        userId === cachedUserId && currentChannelId === cachedCurrentChannelId) {
        return mine ? cachedOwn : cachedIncoming;
    }

    cachedPostsRef = posts;
    cachedChannelsRef = channels;
    cachedUserId = userId;
    cachedCurrentChannelId = currentChannelId;

    const own: string[] = [];
    const incoming: string[] = [];
    for (const post of Object.values(posts)) {
        if (!post) {
            continue;
        }
        const channel = channels[post.channel_id];
        if (channel?.type !== 'D') {
            continue;
        }
        // Scope to the current channel only. Posts in other DMs are invisible
        // to the plugin until the user switches to them; at that point the
        // currentChannelId cache key changes and the cache rebuilds.
        if (post.channel_id !== currentChannelId) {
            continue;
        }
        if (post.user_id === userId) {
            own.push(post.id);
        } else {
            incoming.push(post.id);
        }
    }
    cachedOwn = own;
    cachedIncoming = incoming;
    return mine ? cachedOwn : cachedIncoming;
}

// Own posts are the ones that display a tick, so they get a portal host.
function getOwnDmPostIds(): string[] {
    return collectDmPostIds(true);
}

/**
 * The other side's posts in a direct message — the ones this client is supposed
 * to report as read.
 *
 * They are mounted too, and that is the whole point: `ReadReceipt` renders
 * nothing for a post it does not own, but its effect is what creates the
 * IntersectionObserver that reports the read. Mounting only own posts left the
 * two halves disjoint — the component existed exactly where reporting is
 * disabled — and the plugin could not produce a single receipt.
 *
 * No portal host for these: they render null, so a host would be an empty node
 * inside Mattermost's DOM for nothing. The effect finds the post element by id.
 */
function getIncomingDmPostIds(): string[] {
    return collectDmPostIds(false);
}

function getPostElement(postId: string): HTMLElement | null {
    return document.getElementById(`post_${postId}`) ||
        document.getElementById(`rhsPost_${postId}`) ||
        document.querySelector(`[data-postid="${postId}"]`) ||
        document.querySelector(`[data-post-id="${postId}"]`);
}

// Narrow lookup used both by the incoming-portal key and by the effect that
// attaches the IntersectionObserver. Must match exactly — if the portal thinks
// the element is present (key = ...-1) but the effect cannot find it, the
// component mounts and the retry chain dies without ever creating the observer.
// Incoming posts have no portal host, so the host-lookup branch is irrelevant
// to them; keep the predicate to plain id lookup, which is what ReadReceipt's
// getPostElement falls back to after the host miss.
function getIncomingPostElement(postId: string): HTMLElement | null {
    return document.getElementById(`post_${postId}`);
}

function getOrCreatePortalHost(postId: string): HTMLElement | null {
    const postEl = getPostElement(postId);
    if (!postEl) {
        return null;
    }

    const anchor = postEl.querySelector('.post__body') as HTMLElement | null;
    if (!anchor) {
        return null;
    }

    const cached = portalHosts.get(postId);
    if (cached?.isConnected && anchor.contains(cached)) {
        return cached;
    }

    if (cached) {
        portalHosts.delete(postId);
    }

    const host = document.createElement('div');
    host.className = 'read-receipt-ticks-portal-host';
    host.dataset.postId = postId;
    anchor.appendChild(host);
    portalHosts.set(postId, host);
    return host;
}

function syncPortalHosts(postIds: string[]): boolean {
    let changed = false;
    postIds.forEach((postId) => {
        const previousHost = portalHosts.get(postId);
        const wasConnected = previousHost?.isConnected ?? false;
        const host = getOrCreatePortalHost(postId);
        const isConnected = host?.isConnected ?? false;
        if (isConnected && (!wasConnected || host !== previousHost)) {
            changed = true;
        }
    });
    return changed;
}

function cleanupStaleHosts(currentPostIds: Set<string>): void {
    for (const [postId, host] of portalHosts) {
        if (!currentPostIds.has(postId) || !host.isConnected) {
            host.remove();
            portalHosts.delete(postId);
        }
    }
}

const ReadReceiptPortals: React.FC = () => {
    const [, bumpRender] = useReducer((value: number) => value + 1, 0);
    // Tracks which incoming post ids currently have a DOM element. Compared
    // in checkIncomingPresence (called from resync via rAF) — bumpRenders only
    // when the set actually changes. Scroll/resize can bring virtualised posts
    // into the DOM without a store notification, so this is the hook that
    // catches a late-DOM appearance after the attach-retry window has expired.
    const lastIncomingPresence = useRef<Set<string>>(new Set());

    // Without this the component only ever re-renders on its own retry timers and
    // on scroll/resize, so a message that arrives later gets no component — and
    // for an incoming post that means no observer and no read reported at all.
    //
    // The identity check keeps noop notifications (nothing changed about posts
    // or channels) to two pointer comparisons — Redux hands back the same
    // `posts`/`channels` objects. A real change always costs one traversal in
    // collectDmPostIds, regardless of whether the changed posts are in a DM
    // channel. A deeper hasDmChanges check here was considered and rejected: it
    // would save that traversal only when the change is in a non-DM channel,
    // which is a small saving not worth a second invalidation mechanism.
    useEffect(() => {
        const store = getStore();
        if (!store) {
            return undefined;
        }
        let lastPosts: unknown = null;
        // Track the whole `channels` slice (which contains both the channel map
        // and currentChannelId) — checking only `channels.channels` would miss
        // a channel switch, since that leaves the channel map reference intact.
        let lastChannelsSlice: unknown = null;
        return store.subscribe(() => {
            const state = store.getState();
            const posts = state?.entities?.posts?.posts;
            const channelsSlice = state?.entities?.channels;
            if (posts === lastPosts && channelsSlice === lastChannelsSlice) {
                return;
            }
            lastPosts = posts;
            lastChannelsSlice = channelsSlice;
            bumpRender();
        });
    }, []);

    useEffect(() => {
        const refresh = () => {
            const postIds = getOwnDmPostIds();
            if (syncPortalHosts(postIds)) {
                bumpRender();
            }
            cleanupStaleHosts(new Set(postIds));
        };

        refresh();

        const retryTimers = PORTAL_RETRY_MS.map((delay) => window.setTimeout(refresh, delay));

        // Re-check incoming presence after the current frame. Virtualised
        // lists render their posts in a scroll handler that runs in the
        // bubble phase — resync (capture phase) fires first, before the
        // element exists. Deferring to rAF lets the list render, then we
        // compare against the cached presence set. A single rAF per burst
        // of scroll events keeps the cost bounded (one N-DOM-lookup pass
        // per visual frame, not per scroll event).
        let pendingRaf = 0;
        const schedulePresenceCheck = () => {
            if (pendingRaf) {
                return;
            }
            pendingRaf = window.requestAnimationFrame(() => {
                pendingRaf = 0;
                checkIncomingPresence();
            });
        };

        const checkIncomingPresence = () => {
            const incomingPostIds = getIncomingDmPostIds();
            const present = new Set<string>();
            for (const postId of incomingPostIds) {
                if (getIncomingPostElement(postId)) {
                    present.add(postId);
                }
            }
            const prev = lastIncomingPresence.current;
            const presenceChanged =
                present.size !== prev.size ||
                ![...present].every((id) => prev.has(id));

            if (presenceChanged) {
                lastIncomingPresence.current = present;
                bumpRender();
            }
        };

        const resync = () => {
            const ownPostIds = getOwnDmPostIds();
            const hasMissingOwn = ownPostIds.some((postId) => {
                const host = portalHosts.get(postId);
                return !host?.isConnected;
            });
            if (hasMissingOwn) {
                refresh();
            }
            // Always re-check incoming presence after the frame — scroll may
            // have brought virtualised posts into the DOM, and the capture-
            // phase resync fires before the list's own scroll handler runs.
            schedulePresenceCheck();
        };

        window.addEventListener('scroll', resync, true);
        window.addEventListener('resize', resync);

        return () => {
            retryTimers.forEach((timerId) => window.clearTimeout(timerId));
            window.removeEventListener('scroll', resync, true);
            window.removeEventListener('resize', resync);
            if (pendingRaf) {
                window.cancelAnimationFrame(pendingRaf);
            }
            for (const host of portalHosts.values()) {
                host.remove();
            }
            portalHosts.clear();
        };
    }, []);

    const postIds = getOwnDmPostIds();
    const incomingPostIds = getIncomingDmPostIds();

    return (
        <>
            {postIds.map((postId) => {
                const host = portalHosts.get(postId);
                if (!host?.isConnected) {
                    return null;
                }
                return createPortal(
                    <ReadReceipt key={postId} postId={postId} />,
                    host,
                );
            })}
            {incomingPostIds.map((postId) => {
                // The key includes whether the post element is in the DOM right
                // now. When it appears (virtualised list, slow render), the key
                // flips and React unmounts the old component (whose attach
                // retry may have given up) and mounts a fresh one that will
                // find the element and attach the observer on the first try.
                // Use the same narrow lookup that ReadReceipt's effect uses,
                // so the portal and the effect agree on presence.
                const hasElement = !!getIncomingPostElement(postId);
                return (
                    <ReadReceipt
                        key={`incoming-${postId}-${hasElement ? '1' : '0'}`}
                        postId={postId}
                    />
                );
            })}
        </>
    );
};

export default ReadReceiptPortals;
