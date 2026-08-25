import {GlobalState} from './types';

export interface PostContext {
    postId: string;
    channelId: string;
    createAt: number;
    isOwn: boolean;
    isDM: boolean;
    isCurrentChannel: boolean;
    isDeleted: boolean;
}

export function getPostContext(state: GlobalState, postId: string): PostContext | null {
    const post = state?.entities?.posts?.posts?.[postId];
    if (!post) {
        return null;
    }

    const channelId: string = post.channel_id;
    const channel = state?.entities?.channels?.channels?.[channelId];

    return {
        postId,
        channelId,
        createAt: post.create_at,
        isOwn: post.user_id === state?.entities?.users?.currentUserId,
        isDM: channel?.type === 'D',
        isCurrentChannel: channelId === state?.entities?.channels?.currentChannelId,
        isDeleted: Boolean(post.delete_at) || post.state === 'DELETED',
    };
}

/**
 * A receipt may only be reported for someone else's post in the currently open
 * DM channel. The current-channel check keeps search results, permalink views
 * and RHS previews of other channels from silently marking posts as read.
 */
export function shouldReportRead(state: GlobalState, postId: string): boolean {
    const ctx = getPostContext(state, postId);
    if (!ctx) {
        return false;
    }
    return ctx.isDM && ctx.isCurrentChannel && !ctx.isOwn && !ctx.isDeleted;
}
