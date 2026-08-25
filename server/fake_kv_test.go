package main

import (
	"bytes"
	"sync"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/mock"
)

// fakeKV is a thread-safe in-memory KV store with real compare-and-set
// semantics, so race-sensitive code paths (e.g. the watermark CAS loop) can be
// exercised under go test -race.
type fakeKV struct {
	mu      sync.Mutex
	m       map[string][]byte
	failGet func(key string) *model.AppError
	failSet func(key string) *model.AppError
}

func newFakeKV() *fakeKV {
	return &fakeKV{m: make(map[string][]byte)}
}

func (f *fakeKV) set(key string, value []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make([]byte, len(value))
	copy(cp, value)
	f.m[key] = cp
}

func (f *fakeKV) get(key string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.m[key]
	if !ok {
		return nil
	}
	cp := make([]byte, len(v))
	copy(cp, v)
	return cp
}

// get is the KVGet backing function: returns a copy so the caller mutating the
// returned bytes cannot race with the store, matching Mattermost's semantics.
func (f *fakeKV) kvGet(key string) ([]byte, *model.AppError) {
	if f.failGet != nil {
		if appErr := f.failGet(key); appErr != nil {
			return nil, appErr
		}
	}
	return f.get(key), nil
}

// set implements KVSetWithOptions semantics: if options.Atomic is set, the write
// only happens when the current value equals options.OldValue; a nil OldValue
// means "only if the key does not exist yet" (first-write-wins).
func (f *fakeKV) kvSet(key string, value []byte, options model.PluginKVSetOptions) (bool, *model.AppError) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if options.Atomic {
		cur, exists := f.m[key]
		if options.OldValue == nil {
			// First-write-wins: reject if the key already exists.
			if exists {
				return false, nil
			}
		} else {
			// The CAS must match the exact bytes that were read.
			if !exists || !bytes.Equal(cur, options.OldValue) {
				return false, nil
			}
		}
	}

	cp := make([]byte, len(value))
	copy(cp, value)
	f.m[key] = cp
	return true, nil
}

// wireKV registers a fakeKV on a plugintest.API using func-typed returns, which
// plugintest supports for KVGet/KVSetWithOptions.
func wireKV(api *plugintest.API, kv *fakeKV) {
	api.On("KVGet", mock.Anything).Return(
		func(key string) []byte {
			data, _ := kv.kvGet(key)
			return data
		},
		func(key string) *model.AppError {
			_, appErr := kv.kvGet(key)
			return appErr
		},
	)
	api.On("KVSetWithOptions", mock.Anything, mock.Anything, mock.Anything).Return(
		func(key string, value []byte, options model.PluginKVSetOptions) bool {
			if kv.failSet != nil && kv.failSet(key) != nil {
				return false
			}
			ok, _ := kv.kvSet(key, value, options)
			return ok
		},
		func(key string, value []byte, options model.PluginKVSetOptions) *model.AppError {
			if kv.failSet == nil {
				return nil
			}
			return kv.failSet(key)
		},
	)
}

// stubChannelPosts makes GetPostsForChannel answer the authorship check with
// exactly these posts. A single short page is enough: resolveOwnPosts stops
// paging as soon as a page comes back smaller than the request size.
func stubChannelPosts(api *plugintest.API, channelID string, posts ...*model.Post) {
	list := &model.PostList{Order: make([]string, 0, len(posts)), Posts: make(map[string]*model.Post, len(posts))}
	for _, post := range posts {
		list.Order = append(list.Order, post.Id)
		list.Posts[post.Id] = post
	}
	api.On("GetPostsForChannel", channelID, 0, maxQueryIDs).Return(list, nil)
}

// stubMembers makes GetChannelMembersByIds report exactly memberIDs as members;
// any other id is treated as someone who has left the channel.
func stubMembers(api *plugintest.API, channelID string, memberIDs ...string) {
	allowed := make(map[string]struct{}, len(memberIDs))
	for _, id := range memberIDs {
		allowed[id] = struct{}{}
	}
	api.On("GetChannelMembersByIds", channelID, mock.Anything).Return(
		func(_ string, userIDs []string) model.ChannelMembers {
			members := model.ChannelMembers{}
			for _, id := range userIDs {
				if _, ok := allowed[id]; ok {
					members = append(members, model.ChannelMember{UserId: id, ChannelId: channelID})
				}
			}
			return members
		},
		func(_ string, _ []string) *model.AppError { return nil },
	)
}

// stubAllMembers treats every queried id as a current member.
func stubAllMembers(api *plugintest.API, channelID string) {
	api.On("GetChannelMembersByIds", channelID, mock.Anything).Return(
		func(_ string, userIDs []string) model.ChannelMembers {
			members := model.ChannelMembers{}
			for _, id := range userIDs {
				members = append(members, model.ChannelMember{UserId: id, ChannelId: channelID})
			}
			return members
		},
		func(_ string, _ []string) *model.AppError { return nil },
	)
}
