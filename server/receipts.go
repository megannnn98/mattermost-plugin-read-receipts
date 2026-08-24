package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
)

type Watermark struct {
	PostID   string `json:"post_id"`
	CreateAt int64  `json:"create_at"`
	ReadAt   int64  `json:"read_at"`
}

type Receipt struct {
	PostID    string `json:"post_id"`
	ChannelID string `json:"channel_id"`
	CreateAt  int64  `json:"create_at"`
	ReadAt    int64  `json:"read_at"`
	ReaderID  string `json:"reader_id"`
}

func wmKey(channelID, readerID string) string {
	return fmt.Sprintf("%s%s_%s", kvPrefixWM, channelID, readerID)
}

func rrKey(postID, readerID string) string {
	return fmt.Sprintf("%s%s_%s", kvPrefixRR, postID, readerID)
}

func (p *Plugin) getWatermark(channelID, readerID string) (*Watermark, error) {
	key := wmKey(channelID, readerID)
	data, appErr := p.API.KVGet(key)
	if appErr != nil {
		return nil, fmt.Errorf("kv get: %s", appErr.Error())
	}
	if data == nil {
		return nil, nil
	}
	var wm Watermark
	if err := json.Unmarshal(data, &wm); err != nil {
		return nil, fmt.Errorf("unmarshal watermark: %w", err)
	}
	return &wm, nil
}

func (p *Plugin) setWatermark(channelID, readerID string, wm *Watermark) error {
	data, err := json.Marshal(wm)
	if err != nil {
		return fmt.Errorf("marshal watermark: %w", err)
	}
	key := wmKey(channelID, readerID)
	opts := model.PluginKVSetOptions{
		Atomic:          false,
		OldValue:        nil,
		ExpireInSeconds: 0,
	}
	ok, appErr := p.API.KVSetWithOptions(key, data, opts)
	if !ok || appErr != nil {
		msg := "unknown"
		if appErr != nil {
			msg = appErr.Error()
		}
		return fmt.Errorf("kv set watermark: %s", msg)
	}
	return nil
}

func (p *Plugin) setReceiptAtomic(postID, readerID string, readAt int64, ttlSeconds int64) (bool, error) {
	key := rrKey(postID, readerID)
	data, err := json.Marshal(readAt)
	if err != nil {
		return false, fmt.Errorf("marshal read_at: %w", err)
	}
	opts := model.PluginKVSetOptions{
		Atomic:          true,
		OldValue:        nil,
		ExpireInSeconds: ttlSeconds,
	}
	ok, appErr := p.API.KVSetWithOptions(key, data, opts)
	if appErr != nil {
		return false, fmt.Errorf("kv set receipt: %s", appErr.Error())
	}
	return ok, nil
}

func (p *Plugin) getReceipt(postID, readerID string) (*int64, error) {
	key := rrKey(postID, readerID)
	data, appErr := p.API.KVGet(key)
	if appErr != nil {
		return nil, fmt.Errorf("kv get receipt: %s", appErr.Error())
	}
	if data == nil {
		return nil, nil
	}
	var readAt int64
	if err := json.Unmarshal(data, &readAt); err != nil {
		return nil, fmt.Errorf("unmarshal read_at: %w", err)
	}
	return &readAt, nil
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}
