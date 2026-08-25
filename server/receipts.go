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

const (
	maxWatermarkCASRetries = 5
	// The index CAS loop needs a far larger bound than the watermark one. A
	// watermark loser usually exits immediately on the re-read ("already covered"),
	// so contention resolves itself; every first-time reader of a channel, by
	// contrast, *must* land an append, so the number of retries a writer needs
	// scales with the number of concurrent first readers, not with a constant.
	// At 5 retries a burst of readers entering a busy channel silently lost
	// entries — and a lost entry means that reader's receipts stay invisible
	// until they happen to read again.
	maxIndexCASRetries = 64
	maxIndexReaders    = 1000
	maxQueryReaders    = 200
)

func idxKey(channelID string) string {
	return fmt.Sprintf("%s%s", kvPrefixIDX, channelID)
}

func (p *Plugin) getReaderIndex(channelID string) ([]string, []byte, error) {
	data, appErr := p.API.KVGet(idxKey(channelID))
	if appErr != nil {
		return nil, nil, fmt.Errorf("kv get reader index: %s", appErr.Error())
	}
	if data == nil {
		return nil, nil, nil
	}
	var readers []string
	if err := json.Unmarshal(data, &readers); err != nil {
		return nil, data, fmt.Errorf("unmarshal reader index: %w", err)
	}
	return readers, data, nil
}

// currentMembers keeps only those ids that are still members of the channel. The
// reader index is append-only and has no TTL, so it accumulates people who have
// since left; reporting their reads would both leak activity of someone the
// requester no longer shares a channel with and let departed users fill the
// index until live readers stop being counted.
func (p *Plugin) currentMembers(channelID string, ids []string) (map[string]struct{}, error) {
	present := make(map[string]struct{}, len(ids))
	if len(ids) == 0 {
		return present, nil
	}
	members, appErr := p.API.GetChannelMembersByIds(channelID, ids)
	if appErr != nil {
		return nil, fmt.Errorf("get channel members by ids: %s", appErr.Error())
	}
	for _, member := range members {
		present[member.UserId] = struct{}{}
	}
	return present, nil
}

// readerPage is one bounded window over a channel's readers.
type readerPage struct {
	ids []string
	// truncated reports that the index holds readers past this window, so any
	// count derived from it is a lower bound and must be shown as one.
	truncated bool
	// nextOffset is where a follow-up page starts, or 0 when the index is
	// exhausted.
	nextOffset int
}

// channelReaders returns one page of the channel's readers, excluding the caller
// and anyone who has left the channel. Cost is bounded to maxQueryReaders KV
// reads plus a single membership lookup, no matter how large the channel is.
func (p *Plugin) channelReaders(channelID, excludeID string, offset int) (readerPage, error) {
	index, _, err := p.getReaderIndex(channelID)
	if err != nil {
		return readerPage{}, err
	}

	candidates := make([]string, 0, maxQueryReaders)
	seen := 0
	truncated := false
	consumed := offset
	for i := offset; i < len(index); i++ {
		if index[i] == excludeID {
			consumed = i + 1
			continue
		}
		if seen == maxQueryReaders {
			truncated = true
			break
		}
		candidates = append(candidates, index[i])
		seen++
		consumed = i + 1
	}

	members, err := p.currentMembers(channelID, candidates)
	if err != nil {
		return readerPage{}, err
	}
	page := readerPage{ids: make([]string, 0, len(candidates)), truncated: truncated}
	for _, readerID := range candidates {
		if _, ok := members[readerID]; ok {
			page.ids = append(page.ids, readerID)
		}
	}
	if truncated {
		page.nextOffset = consumed
	}
	return page, nil
}

// pruneReaderIndex drops readers who have left the channel. It runs only when the
// index is full, so the membership lookup it costs is a rare event rather than
// something every read pays for.
func (p *Plugin) pruneReaderIndex(channelID string, readers []string) ([]string, error) {
	members, err := p.currentMembers(channelID, readers)
	if err != nil {
		return nil, err
	}
	kept := make([]string, 0, len(readers))
	for _, readerID := range readers {
		if _, ok := members[readerID]; ok {
			kept = append(kept, readerID)
		}
	}
	return kept, nil
}

func (p *Plugin) ensureReaderIndexed(channelID, readerID string) error {
	key := idxKey(channelID)
	for attempt := 0; attempt < maxIndexCASRetries; attempt++ {
		readers, raw, err := p.getReaderIndex(channelID)
		if err != nil {
			return err
		}
		for _, existing := range readers {
			if existing == readerID {
				return nil
			}
		}
		if len(readers) >= maxIndexReaders {
			pruned, err := p.pruneReaderIndex(channelID, readers)
			if err != nil {
				return err
			}
			if len(pruned) >= maxIndexReaders {
				p.logWarn("reader index is full", "channel_id", channelID, "max_readers", maxIndexReaders)
				return nil
			}
			readers = pruned
		}
		data, err := json.Marshal(append(readers, readerID))
		if err != nil {
			return fmt.Errorf("marshal reader index: %w", err)
		}
		ok, appErr := p.API.KVSetWithOptions(key, data, model.PluginKVSetOptions{Atomic: true, OldValue: raw})
		if appErr != nil {
			return fmt.Errorf("kv set reader index: %s", appErr.Error())
		}
		if ok {
			return nil
		}
	}
	// Exhaustion is reported, never swallowed: the caller turns it into a 500 and
	// the client's backoff retries once the burst is over. Silently giving up
	// would drop the reader from every future count.
	return fmt.Errorf("reader index CAS failed after %d attempts", maxIndexCASRetries)
}

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
