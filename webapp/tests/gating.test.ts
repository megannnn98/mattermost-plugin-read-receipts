import {getPostContext, shouldReportRead} from '../src/gating';
import {makeGlobalState} from './helpers';

const CHANNELS = {
    dm: {id: 'dm', type: 'D'},
    group: {id: 'group', type: 'G'},
    open: {id: 'open', type: 'O'},
};

const POSTS = {
    theirs: {id: 'theirs', user_id: 'other', channel_id: 'dm', create_at: 1000},
    mine: {id: 'mine', user_id: 'me', channel_id: 'dm', create_at: 1000},
    elsewhere: {id: 'elsewhere', user_id: 'other', channel_id: 'group', create_at: 1000},
    deleted: {id: 'deleted', user_id: 'other', channel_id: 'dm', create_at: 1000, delete_at: 5},
    reply: {id: 'reply', user_id: 'other', channel_id: 'dm', create_at: 1000, root_id: 'theirs'},
    inOpen: {id: 'inOpen', user_id: 'other', channel_id: 'open', create_at: 1000},
};

const state = (enabled: string | null, currentChannelId = 'dm') => makeGlobalState({
    currentChannelId,
    channels: CHANNELS,
    posts: POSTS,
    plugin: {config: enabled === null ? null : {enabled_channel_types: enabled}},
});

describe('getPostContext', () => {
    it('returns null for an unknown post', () => {
        expect(getPostContext(state('DGPO'), 'nope')).toBeNull();
    });

    it('describes ownership, channel type, thread position and current channel', () => {
        expect(getPostContext(state('DGPO'), 'theirs')).toEqual({
            postId: 'theirs',
            channelId: 'dm',
            createAt: 1000,
            isOwn: false,
            isDM: true,
            isEligibleChannel: true,
            isCurrentChannel: true,
            isDeleted: false,
            isThreadReply: false,
        });
    });

    it('follows the server configuration for eligibility', () => {
        expect(getPostContext(state('D'), 'inOpen')?.isEligibleChannel).toBe(false);
        expect(getPostContext(state('DO'), 'inOpen')?.isEligibleChannel).toBe(true);
    });
});

describe('shouldReportRead', () => {
    it('reports someone else post in the open channel', () => {
        expect(shouldReportRead(state('DGPO'), 'theirs')).toBe(true);
    });

    it('never reports own post', () => {
        expect(shouldReportRead(state('DGPO'), 'mine')).toBe(false);
    });

    it('does not report a post of a channel that is not currently open', () => {
        expect(shouldReportRead(state('DGPO'), 'elsewhere')).toBe(false);
    });

    it('does not report deleted posts', () => {
        expect(shouldReportRead(state('DGPO'), 'deleted')).toBe(false);
    });

    it('does not report unknown posts', () => {
        expect(shouldReportRead(state('DGPO'), 'nope')).toBe(false);
    });

    it('does not report thread replies', () => {
        // A reply shares its root's channel, so tracking it would let a reply read
        // in the sidebar advance the channel watermark over older messages.
        expect(shouldReportRead(state('DGPO'), 'reply')).toBe(false);
    });

    it('does not report in a channel type the administrator disabled', () => {
        expect(shouldReportRead(state('GPO'), 'theirs')).toBe(false);
    });

    it('does not report before the configuration is known', () => {
        expect(shouldReportRead(state(null), 'theirs')).toBe(false);
    });
});
