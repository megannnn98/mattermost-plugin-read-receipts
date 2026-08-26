import React, {useEffect, useReducer} from 'react';
import {createPortal} from 'react-dom';

import ReadReceipt from './read_receipt';
import {getStore} from '../store_ref';

const PORTAL_RETRY_MS = [250, 1000, 3000, 5000];

const portalHosts = new Map<string, HTMLElement>();

// Cached own/incoming DM post id lists. Both are rebuilt in one pass when any
// of the cache keys change — posts, channels, or the current user. Returning
// the cached array by reference is safe because every consumer only reads it
// (syncPortalHosts, cleanupStaleHosts, some, map).
//
// A separate hasDmChanges check in the store subscription (checking whether the
// changed posts are actually in DM channels) was considered and rejected: the
// identity cache below already makes a noop notification two pointer
// comparisons, and adding a second invalidation mechanism would be complexity
// for a saving already solved.
let cachedPostsRef: unknown = null;
let cachedChannelsRef: unknown = null;
let cachedUserId: string | null = null;
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
        cachedOwn = [];
        cachedIncoming = [];
        return [];
    }

    const state = store.getState();
    const posts = state?.entities?.posts?.posts ?? {};
    const channels = state?.entities?.channels?.channels ?? {};
    const userId = state?.entities?.users?.currentUserId ?? null;

    if (posts === cachedPostsRef && channels === cachedChannelsRef && userId === cachedUserId) {
        return mine ? cachedOwn : cachedIncoming;
    }

    cachedPostsRef = posts;
    cachedChannelsRef = channels;
    cachedUserId = userId;

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

    // Without this the component only ever re-renders on its own retry timers and
    // on scroll/resize, so a message that arrives later gets no component — and
    // for an incoming post that means no observer and no read reported at all.
    //
    // The identity check keeps the cost to two pointer comparisons per store
    // notification: Redux hands back the same `posts`/`channels` objects when
    // nothing about them changed. A deeper check (did the changed posts actually
    // land in a DM channel?) was considered and rejected — the memoized
    // collectDmPostIds below already makes a re-render cheap, and adding a second
    // invalidation mechanism would be complexity for a saving already solved.
    useEffect(() => {
        const store = getStore();
        if (!store) {
            return undefined;
        }
        let lastPosts: unknown = null;
        let lastChannels: unknown = null;
        return store.subscribe(() => {
            const state = store.getState();
            const posts = state?.entities?.posts?.posts;
            const channels = state?.entities?.channels?.channels;
            if (posts === lastPosts && channels === lastChannels) {
                return;
            }
            lastPosts = posts;
            lastChannels = channels;
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

        const resync = () => {
            const postIds = getOwnDmPostIds();
            const hasMissing = postIds.some((postId) => {
                const host = portalHosts.get(postId);
                return !host?.isConnected;
            });
            if (hasMissing) {
                refresh();
            }
        };

        window.addEventListener('scroll', resync, true);
        window.addEventListener('resize', resync);

        return () => {
            retryTimers.forEach((timerId) => window.clearTimeout(timerId));
            window.removeEventListener('scroll', resync, true);
            window.removeEventListener('resize', resync);
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
            {incomingPostIds.map((postId) => (
                <ReadReceipt key={`incoming-${postId}`} postId={postId} />
            ))}
        </>
    );
};

export default ReadReceiptPortals;
