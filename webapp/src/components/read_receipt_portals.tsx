import React, {useEffect, useReducer} from 'react';
import {createPortal} from 'react-dom';

import ReadReceipt from './read_receipt';
import {getStore} from '../store_ref';

const PORTAL_RETRY_MS = [250, 1000, 3000, 5000];

const portalHosts = new Map<string, HTMLElement>();

function getOwnDmPostIds(): string[] {
    const store = getStore();
    if (!store) {
        return [];
    }
    const state = store.getState();
    const currentUserId = state?.entities?.users?.currentUserId;
    if (!currentUserId) {
        return [];
    }

    const posts = state?.entities?.posts?.posts ?? {};
    const channels = state?.entities?.channels?.channels ?? {};
    const postIds: string[] = [];
    for (const post of Object.values(posts)) {
        if (!post || post.user_id !== currentUserId) {
            continue;
        }
        const channel = channels[post.channel_id];
        if (channel?.type === 'D') {
            postIds.push(post.id);
        }
    }
    return postIds;
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
        </>
    );
};

export default ReadReceiptPortals;
