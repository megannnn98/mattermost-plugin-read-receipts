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
	mu sync.Mutex
	m  map[string][]byte
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
		func(key string) *model.AppError { return nil },
	)
	api.On("KVSetWithOptions", mock.Anything, mock.Anything, mock.Anything).Return(
		func(key string, value []byte, options model.PluginKVSetOptions) bool {
			ok, _ := kv.kvSet(key, value, options)
			return ok
		},
		func(key string, value []byte, options model.PluginKVSetOptions) *model.AppError { return nil },
	)
}
