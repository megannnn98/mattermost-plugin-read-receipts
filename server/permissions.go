package main

import (
	"errors"
	"fmt"

	"github.com/mattermost/mattermost/server/public/model"
)

var (
	ErrChannelTypeDisabled = errors.New("read receipts are disabled for this channel type")
	ErrNotMember           = errors.New("user is not a member of the channel")
	ErrAuthorSelfRead      = errors.New("author cannot mark own post as read")
	ErrPostNotFound        = errors.New("post not found")
	ErrChannelNotFound     = errors.New("channel not found")
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

	if !p.getConfiguration().channelTypeEnabled(string(channel.Type)) {
		return nil, nil, ErrChannelTypeDisabled
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

	if !p.getConfiguration().channelTypeEnabled(string(channel.Type)) {
		return nil, ErrChannelTypeDisabled
	}

	if !p.API.HasPermissionToChannel(userID, channelID, model.PermissionReadChannel) {
		return nil, ErrNotMember
	}

	return channel, nil
}
