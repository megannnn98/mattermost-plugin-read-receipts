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

func rrKey(channelID, postID, readerID string) string {
	return fmt.Sprintf("%s%s_%s_%s", kvPrefixRR, channelID, postID, readerID)
}

// Authorization invariant (see handleQuery):
//   - The per-post receipt is keyed by the post's channel: `rr_<channelID>_<postID>_<readerID>`
//     exists iff `readerID` read `postID` inside `channelID`. Reading one's own post is
//     rejected (ErrAuthorSelfRead), a DM is always 1:1, and `readerID` is the second
//     member, so the author of the post is always the requester. A requester who passes a
//     post_id from a different channel can therefore never read someone else's receipt:
//     the key prefix (validated channel.Id) simply won't match.
//   - This is a structural guarantee that deliberately avoids an extra GetPost per post_id
//     (up to 200 API calls per DM open would be an unacceptable regression).
//
// Migration: version 0.1.0 has no public installations, so backward compatibility is not
// kept. Old `rr_<postID>_<readerID>` keys still exist with a TTL, but they are never read
// under the new `rr_<channelID>_<postID>_<readerID>` scheme and expire on their own within
// ReceiptRetentionDays. The `wm_*` key format is unchanged.

const maxWatermarkCASRetries = 5

// getWatermarkRaw returns the parsed watermark AND the raw bytes that were read
// from KV. The raw bytes are what OldValue for the CAS write must be — not the
// result of re-marshalling the parsed struct, which would not byte-equal what a
// concurrent writer put there.
func (p *Plugin) getWatermarkRaw(channelID, readerID string) (*Watermark, []byte, error) {
	key := wmKey(channelID, readerID)
	data, appErr := p.API.KVGet(key)
	if appErr != nil {
		return nil, nil, fmt.Errorf("kv get: %s", appErr.Error())
	}
	if data == nil {
		return nil, nil, nil
	}
	var wm Watermark
	if err := json.Unmarshal(data, &wm); err != nil {
		return nil, data, fmt.Errorf("unmarshal watermark: %w", err)
	}
	return &wm, data, nil
}

func (p *Plugin) getWatermark(channelID, readerID string) (*Watermark, error) {
	wm, _, err := p.getWatermarkRaw(channelID, readerID)
	return wm, err
}

// advanceWatermark conditionally raises the monotonic watermark for
// (channelID, readerID) to cover `post`, using an atomic compare-and-set so that
// concurrent readers cannot roll the watermark backward (KVGet + KVSet is not
// atomic, and the plugin may run in more than one process, so a process-local
// mutex is not enough).
//
// Returns (true, nil) if the watermark advanced, (false, nil) if the new post is
// older than or equal to the existing watermark (nothing to do), and an error if
// the CAS kept losing to a concurrent writer past maxWatermarkCASRetries.
func (p *Plugin) advanceWatermark(channelID, readerID string, post *model.Post, now int64) (bool, error) {
	key := wmKey(channelID, readerID)

	for attempt := 0; attempt < maxWatermarkCASRetries; attempt++ {
		wm, raw, err := p.getWatermarkRaw(channelID, readerID)
		if err != nil {
			return false, err
		}

		if wm != nil && post.CreateAt <= wm.CreateAt {
			// Watermark already covers this post — never move it backward.
			return false, nil
		}

		newWM := &Watermark{
			PostID:   post.Id,
			CreateAt: post.CreateAt,
			ReadAt:   now,
		}
		data, err := json.Marshal(newWM)
		if err != nil {
			return false, fmt.Errorf("marshal watermark: %w", err)
		}

		opts := model.PluginKVSetOptions{
			Atomic:          true,
			OldValue:        raw, // nil if the key did not exist before
			ExpireInSeconds: 0,
		}
		ok, appErr := p.API.KVSetWithOptions(key, data, opts)
		if appErr != nil {
			return false, fmt.Errorf("kv set watermark: %s", appErr.Error())
		}
		if ok {
			return true, nil
		}
		// CAS conflict: someone else wrote after our read. Loop to re-read and
		// re-check monotonicity against the freshest value.
	}

	return false, fmt.Errorf("watermark CAS failed after %d attempts", maxWatermarkCASRetries)
}

func (p *Plugin) setReceiptAtomic(channelID, postID, readerID string, readAt int64, ttlSeconds int64) (bool, error) {
	key := rrKey(channelID, postID, readerID)
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

func (p *Plugin) getReceipt(channelID, postID, readerID string) (*int64, error) {
	key := rrKey(channelID, postID, readerID)
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
