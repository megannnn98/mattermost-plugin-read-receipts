package main

import (
	"errors"
	"fmt"

	"github.com/mattermost/mattermost/server/public/model"
)

var (
	ErrNotDMChannel    = errors.New("channel is not a DM")
	ErrNotMember       = errors.New("user is not a member of the channel")
	ErrAuthorSelfRead  = errors.New("author cannot mark own post as read")
	ErrPostNotFound    = errors.New("post not found")
	ErrChannelNotFound = errors.New("channel not found")
)

func (p *Plugin) validateReadRequest(userID, postID string) (*model.Post, *model.Channel, error) {
	post, appErr := p.API.GetPost(postID)
	if appErr != nil {
		return nil, nil, fmt.Errorf("%w: %s", ErrPostNotFound, appErr.Error())
	}

	channel, appErr := p.API.GetChannel(post.ChannelId)
	if appErr != nil {
		return nil, nil, fmt.Errorf("%w: %s", ErrChannelNotFound, appErr.Error())
	}

	if channel.Type != model.ChannelTypeDirect {
		return nil, nil, ErrNotDMChannel
	}

	if !p.API.HasPermissionToChannel(userID, channel.Id, model.PermissionReadChannel) {
		return nil, nil, ErrNotMember
	}

	if post.UserId == userID {
		return nil, nil, ErrAuthorSelfRead
	}

	return post, channel, nil
}

func (p *Plugin) validateQueryRequest(userID, channelID string) (*model.Channel, error) {
	channel, appErr := p.API.GetChannel(channelID)
	if appErr != nil {
		return nil, fmt.Errorf("%w: %s", ErrChannelNotFound, appErr.Error())
	}

	if channel.Type != model.ChannelTypeDirect {
		return nil, ErrNotDMChannel
	}

	if !p.API.HasPermissionToChannel(userID, channelID, model.PermissionReadChannel) {
		return nil, ErrNotMember
	}

	return channel, nil
}

func (p *Plugin) getOtherDMMember(channel *model.Channel, userID string) (string, error) {
	members, appErr := p.API.GetChannelMembers(channel.Id, 0, 2)
	if appErr != nil {
		return "", fmt.Errorf("get channel members: %s", appErr.Error())
	}

	for _, m := range members {
		if m.UserId != userID {
			return m.UserId, nil
		}
	}

	return "", fmt.Errorf("other member not found in DM")
}
