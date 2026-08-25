import {isChannelTypeEnabled} from './selectors';
import {GlobalState} from './types';

export interface PostContext {
    postId: string;
    channelId: string;
    createAt: number;
    isOwn: boolean;
    isDM: boolean;
    isEligibleChannel: boolean;
    isCurrentChannel: boolean;
    isDeleted: boolean;
    isThreadReply: boolean;
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
        isEligibleChannel: isChannelTypeEnabled(state, channel?.type),
        isCurrentChannel: channelId === state?.entities?.channels?.currentChannelId,
        isDeleted: Boolean(post.delete_at) || post.state === 'DELETED',
        isThreadReply: Boolean(post.root_id),
    };
}

/**
 * A receipt may only be reported for someone else's root post in the channel that
 * is currently open, and only in a channel type the server is collecting for.
 *
 * Thread replies are deliberately out of scope for this version. A reply lives in
 * the same channel as its root, so without this check a reply that happened to be
 * rendered — in the right-hand sidebar, in the global threads view — would be
 * tracked as if it had been read in the channel, and its watermark would then mark
 * every older channel message read too. The current-channel check keeps search
 * results and permalink views out for the same reason.
 */
export function shouldReportRead(state: GlobalState, postId: string): boolean {
    const ctx = getPostContext(state, postId);
    if (!ctx) {
        return false;
    }
    return ctx.isEligibleChannel && ctx.isCurrentChannel && !ctx.isOwn && !ctx.isDeleted && !ctx.isThreadReply;
}
