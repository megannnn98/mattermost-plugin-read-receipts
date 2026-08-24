import {getPostContext, shouldReportRead} from '../src/gating';

function makeState(overrides: any = {}) {
    return {
        entities: {
            users: {currentUserId: 'me'},
            channels: {
                currentChannelId: 'dm1',
                channels: {
                    dm1: {id: 'dm1', type: 'D'},
                    dm2: {id: 'dm2', type: 'D'},
                    town: {id: 'town', type: 'O'},
                },
            },
            posts: {
                posts: {
                    theirs: {id: 'theirs', user_id: 'other', channel_id: 'dm1', create_at: 100},
                    mine: {id: 'mine', user_id: 'me', channel_id: 'dm1', create_at: 200},
                    otherChannel: {id: 'otherChannel', user_id: 'other', channel_id: 'dm2', create_at: 300},
                    inTown: {id: 'inTown', user_id: 'other', channel_id: 'town', create_at: 400},
                    deleted: {id: 'deleted', user_id: 'other', channel_id: 'dm1', create_at: 500, delete_at: 501},
                },
            },
        },
        ...overrides,
    };
}

describe('getPostContext', () => {
    it('returns null for an unknown post', () => {
        expect(getPostContext(makeState(), 'nope')).toBeNull();
    });

    it('describes ownership, channel type and current channel', () => {
        const ctx = getPostContext(makeState(), 'mine');
        expect(ctx).toMatchObject({
            channelId: 'dm1',
            createAt: 200,
            isOwn: true,
            isDM: true,
            isCurrentChannel: true,
            isDeleted: false,
        });
    });
});

describe('shouldReportRead', () => {
    it('reports someone else post in the open DM', () => {
        expect(shouldReportRead(makeState(), 'theirs')).toBe(true);
    });

    it('never reports own post', () => {
        expect(shouldReportRead(makeState(), 'mine')).toBe(false);
    });

    it('does not report a post of a DM that is not currently open', () => {
        expect(shouldReportRead(makeState(), 'otherChannel')).toBe(false);
    });

    it('does not report posts outside DM channels', () => {
        const state = makeState();
        state.entities.channels.currentChannelId = 'town';
        expect(shouldReportRead(state, 'inTown')).toBe(false);
    });

    it('does not report deleted posts', () => {
        expect(shouldReportRead(makeState(), 'deleted')).toBe(false);
    });

    it('does not report unknown posts', () => {
        expect(shouldReportRead(makeState(), 'nope')).toBe(false);
    });
});
