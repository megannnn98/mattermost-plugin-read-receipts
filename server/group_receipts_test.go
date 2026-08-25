package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func doPostReaders(p *Plugin, body []byte, userID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/v1/receipts/post", bytes.NewReader(body))
	if userID != "" {
		req.Header.Set("Mattermost-User-Id", userID)
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)
	return w
}

func readIndex(t *testing.T, kv *fakeKV, channelID string) []string {
	t.Helper()
	data := kv.get(idxKey(channelID))
	if data == nil {
		return nil
	}
	var readers []string
	require.NoError(t, json.Unmarshal(data, &readers))
	return readers
}

// --- Reader index -----------------------------------------------------------

// The index is written with the same CAS discipline as the watermark, so
// concurrent first-time readers must not lose each other's entries.
func TestEnsureReaderIndexed_ConcurrentReadersAllLand(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanIdxRace")

	const n = 50
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			if err := p.ensureReaderIndexed(channelID, validID(fmt.Sprintf("rdr%d", i))); err != nil {
				t.Errorf("ensureReaderIndexed: %v", err)
			}
		}(i)
	}
	wg.Wait()

	readers := readIndex(t, kv, channelID)
	require.Len(t, readers, n, "every concurrent reader must be indexed exactly once")

	unique := make(map[string]struct{}, len(readers))
	for _, readerID := range readers {
		unique[readerID] = struct{}{}
	}
	assert.Len(t, unique, n, "the index must not contain duplicates")
}

// Indexing costs one KVGet per read; the write happens only the first time.
func TestEnsureReaderIndexed_RepeatDoesNotWrite(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanIdxOnce")
	readerID := validID("rdrOnce")

	require.NoError(t, p.ensureReaderIndexed(channelID, readerID))

	writes := 0
	kv.failSet = func(key string) *model.AppError {
		if key == idxKey(channelID) {
			writes++
		}
		return nil
	}
	require.NoError(t, p.ensureReaderIndexed(channelID, readerID))
	assert.Zero(t, writes, "an already indexed reader must not be written again")
}

// Overflow is a bounded-cost decision, not an error: the read still succeeds,
// the reader is simply not counted (documented residual risk).
func TestEnsureReaderIndexed_OverflowIsNotAnError(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanIdxFull")
	full := make([]string, 0, maxIndexReaders)
	for i := 0; i < maxIndexReaders; i++ {
		full = append(full, validID(fmt.Sprintf("full%d", i)))
	}
	kv.set(idxKey(channelID), mustJSON(t, full))

	require.NoError(t, p.ensureReaderIndexed(channelID, validID("rdrOverflow")))
	assert.Len(t, readIndex(t, kv, channelID), maxIndexReaders, "the index must stay capped and keep what it had")
}

// v0.1.0 installations have wm_ keys but no idx_ key. The first read after the
// upgrade must re-index the reader so the query starts seeing them again.
func TestMarkAsRead_IndexesReaderMissingFromLegacyState(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything).Return()

	channelID := validID("chanLegacy")
	readerID := validID("rdrLegacy")
	authorID := validID("authorLegacy")

	// Legacy state: the reader already has a watermark but is not in any index.
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("oldPost"), CreateAt: 1000, ReadAt: 1500}))
	require.Nil(t, kv.get(idxKey(channelID)))

	post := &model.Post{Id: validID("newPost"), UserId: authorID, ChannelId: channelID, CreateAt: 2000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	_, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)

	assert.Equal(t, []string{readerID}, readIndex(t, kv, channelID))
}

// The watermark-authority early return happens before any write, so the index
// must be maintained ahead of it or an old-post read would never self-heal.
func TestMarkAsRead_IndexesReaderOnCoveredPost(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanCovered")
	readerID := validID("rdrCovered")

	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("newerPost"), CreateAt: 5000, ReadAt: 5500}))

	post := &model.Post{Id: validID("olderPost"), UserId: validID("authorCovered"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	_, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)

	assert.Equal(t, []string{readerID}, readIndex(t, kv, channelID))
}

// --- Group query ------------------------------------------------------------

func TestHandleQuery_GroupReturnsWatermarkPerReader(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	userID := validID("authorGroup")
	readerA := validID("groupA")
	readerB := validID("groupB")
	channelID := validID("chanGroupQ")

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeGroup}, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)

	// The requester is in the index too (they read other people's posts here).
	kv.set(idxKey(channelID), mustJSON(t, []string{readerA, userID, readerB}))
	kv.set(wmKey(channelID, readerA), mustJSON(t, Watermark{PostID: validID("pA"), CreateAt: 3000, ReadAt: 3100}))
	kv.set(wmKey(channelID, readerB), mustJSON(t, Watermark{PostID: validID("pB"), CreateAt: 1000, ReadAt: 1100}))
	kv.set(wmKey(channelID, userID), mustJSON(t, Watermark{PostID: validID("pSelf"), CreateAt: 9000, ReadAt: 9100}))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{validID("anyPost")}}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	require.Len(t, resp.Watermarks, 2, "the requester's own watermark must not be reported back to them")

	byReader := map[string]watermarkResponse{}
	for _, wm := range resp.Watermarks {
		byReader[wm.ReaderID] = wm
	}
	assert.Equal(t, int64(3000), byReader[readerA].CreateAt)
	assert.Equal(t, int64(1000), byReader[readerB].CreateAt)
	assert.NotContains(t, byReader, userID)
	assert.False(t, resp.Truncated)
}

// Exact per-post receipts cost K*M reads, so they are only served for a single
// reader — in practice a DM. Groups get exact times from /receipts/post.
func TestHandleQuery_ExactReceiptsOnlyForSingleReader(t *testing.T) {
	postID := validID("sharedPost")

	setup := func(t *testing.T, readers []string) queryResponse {
		t.Helper()
		kv := newFakeKV()
		p, api := setupTestPlugin(t)
		wireKV(api, kv)

		userID := validID("authorExact")
		channelID := validID("chanExact")
		api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeGroup}, nil)
		api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)

		kv.set(idxKey(channelID), mustJSON(t, readers))
		for _, readerID := range readers {
			kv.set(rrKey(channelID, postID, readerID), mustJSON(t, int64(4200)))
		}

		w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{postID}}), userID)
		require.Equal(t, http.StatusOK, w.Code)
		var resp queryResponse
		require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
		return resp
	}

	single := validID("soleReader")
	resp := setup(t, []string{single})
	assert.Equal(t, int64(4200), resp.Receipts[postID][single], "a single reader keeps the exact v0.1 contract")

	resp = setup(t, []string{validID("manyA"), validID("manyB")})
	assert.Empty(t, resp.Receipts, "more than one reader must not trigger K*M receipt reads")
}

func TestHandleQuery_TruncatesReaderList(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	userID := validID("authorTrunc")
	channelID := validID("chanTrunc")
	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeOpen}, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)

	readers := make([]string, 0, maxQueryReaders+5)
	for i := 0; i < maxQueryReaders+5; i++ {
		readerID := validID(fmt.Sprintf("crowd%d", i))
		readers = append(readers, readerID)
		kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("pc"), CreateAt: 1000, ReadAt: 1100}))
	}
	kv.set(idxKey(channelID), mustJSON(t, readers))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Len(t, resp.Watermarks, maxQueryReaders)
	assert.True(t, resp.Truncated, "a capped reader list must say so instead of silently shrinking")
}

// --- Channel types ----------------------------------------------------------

func TestValidate_ChannelTypesAreConfigurable(t *testing.T) {
	types := []model.ChannelType{
		model.ChannelTypeDirect,
		model.ChannelTypeGroup,
		model.ChannelTypePrivate,
		model.ChannelTypeOpen,
	}

	for _, channelType := range types {
		t.Run(string(channelType)+" enabled by default", func(t *testing.T) {
			p, api := setupTestPlugin(t)
			userID := validID("userTypes")
			channelID := validID("chanTypes")
			api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: channelType}, nil)
			api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
			api.On("KVGet", idxKey(channelID)).Return(nil, nil)

			w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID}), userID)
			assert.Equal(t, http.StatusOK, w.Code)
		})

		t.Run(string(channelType)+" rejected when excluded", func(t *testing.T) {
			p, api := setupTestPlugin(t)
			p.configuration.EnabledChannelTypes = normalizeChannelTypes(strings.ReplaceAll(defaultChannelTypes, string(channelType), ""))
			userID := validID("userTypes")
			channelID := validID("chanTypes")
			api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: channelType}, nil)

			w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID}), userID)
			assert.Equal(t, http.StatusForbidden, w.Code)
		})
	}
}

func TestHandleQuery_NonMemberForbiddenInEveryChannelType(t *testing.T) {
	for _, channelType := range []model.ChannelType{model.ChannelTypeGroup, model.ChannelTypePrivate, model.ChannelTypeOpen} {
		t.Run(string(channelType), func(t *testing.T) {
			p, api := setupTestPlugin(t)
			userID := validID("outsider")
			channelID := validID("chanOutsider")
			api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: channelType}, nil)
			api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(false)

			w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID}), userID)
			assert.Equal(t, http.StatusForbidden, w.Code)
		})
	}
}

// --- /receipts/post ---------------------------------------------------------

type postReadersFixture struct {
	plugin    *Plugin
	kv        *fakeKV
	channelID string
	postID    string
	authorID  string
}

func newPostReadersFixture(t *testing.T, post *model.Post, channelType model.ChannelType) postReadersFixture {
	t.Helper()
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	api.On("GetPost", post.Id).Return(post, nil)
	api.On("GetChannel", post.ChannelId).Return(&model.Channel{Id: post.ChannelId, Type: channelType}, nil)
	api.On("HasPermissionToChannel", mock.Anything, post.ChannelId, model.PermissionReadChannel).Return(true)

	return postReadersFixture{plugin: p, kv: kv, channelID: post.ChannelId, postID: post.Id, authorID: post.UserId}
}

func TestHandlePostReaders_OnlyAuthorMayAsk(t *testing.T) {
	post := &model.Post{Id: validID("postAuth"), UserId: validID("authorAuth"), ChannelId: validID("chanAuth"), CreateAt: 1000}
	f := newPostReadersFixture(t, post, model.ChannelTypeGroup)

	w := doPostReaders(f.plugin, mustJSON(t, postReadersRequest{PostID: post.Id}), validID("nosyMember"))
	assert.Equal(t, http.StatusForbidden, w.Code, "a channel member who is not the author must not see per-post readers")
}

func TestHandlePostReaders_DeletedPostIsNotFound(t *testing.T) {
	post := &model.Post{Id: validID("postGone"), UserId: validID("authorGone"), ChannelId: validID("chanGone"), CreateAt: 1000, DeleteAt: 2000}
	f := newPostReadersFixture(t, post, model.ChannelTypeGroup)

	w := doPostReaders(f.plugin, mustJSON(t, postReadersRequest{PostID: post.Id}), post.UserId)
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestHandlePostReaders_ExactAndApproximateTimes(t *testing.T) {
	post := &model.Post{Id: validID("postMixed"), UserId: validID("authorMixed"), ChannelId: validID("chanMixed"), CreateAt: 2000}
	f := newPostReadersFixture(t, post, model.ChannelTypeGroup)

	exactReader := validID("rdrExact")
	expiredReader := validID("rdrExpired")
	staleReader := validID("rdrStale")

	f.kv.set(idxKey(f.channelID), mustJSON(t, []string{exactReader, expiredReader, staleReader, f.authorID}))
	// Still has a per-post receipt.
	f.kv.set(rrKey(f.channelID, f.postID, exactReader), mustJSON(t, int64(2500)))
	f.kv.set(wmKey(f.channelID, exactReader), mustJSON(t, Watermark{PostID: f.postID, CreateAt: 2000, ReadAt: 2500}))
	// Receipt expired by TTL; the watermark still proves the post was read.
	f.kv.set(wmKey(f.channelID, expiredReader), mustJSON(t, Watermark{PostID: validID("laterPost"), CreateAt: 9000, ReadAt: 9100}))
	// Never got this far in the channel.
	f.kv.set(wmKey(f.channelID, staleReader), mustJSON(t, Watermark{PostID: validID("earlyPost"), CreateAt: 1000, ReadAt: 1100}))

	w := doPostReaders(f.plugin, mustJSON(t, postReadersRequest{PostID: f.postID}), f.authorID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp postReadersResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	require.Len(t, resp.Readers, 2, "only readers whose state covers the post are reported")

	assert.Equal(t, exactReader, resp.Readers[0].UserID)
	assert.Equal(t, int64(2500), resp.Readers[0].ReadAt)
	assert.True(t, resp.Readers[0].Exact)

	assert.Equal(t, expiredReader, resp.Readers[1].UserID)
	assert.Equal(t, int64(9100), resp.Readers[1].ReadAt)
	assert.False(t, resp.Readers[1].Exact, "an expired receipt must be reported as approximate, not as an exact time")
}

// A precise receipt already answers the question, so the watermark read is pure
// waste — at 200 readers it would double the cost of opening the popover.
func TestHandlePostReaders_SkipsWatermarkWhenReceiptExists(t *testing.T) {
	post := &model.Post{Id: validID("postCheap"), UserId: validID("authorCheap"), ChannelId: validID("chanCheap"), CreateAt: 1000}
	f := newPostReadersFixture(t, post, model.ChannelTypeGroup)

	readerID := validID("rdrCheap")
	f.kv.set(idxKey(f.channelID), mustJSON(t, []string{readerID}))
	f.kv.set(rrKey(f.channelID, f.postID, readerID), mustJSON(t, int64(1500)))

	f.kv.failGet = func(key string) *model.AppError {
		if key == wmKey(f.channelID, readerID) {
			return model.NewAppError("kv", "watermark must not be read", nil, "", http.StatusInternalServerError)
		}
		return nil
	}

	w := doPostReaders(f.plugin, mustJSON(t, postReadersRequest{PostID: f.postID}), f.authorID)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestHandlePostReaders_TruncatesReaderList(t *testing.T) {
	post := &model.Post{Id: validID("postCrowd"), UserId: validID("authorCrowd"), ChannelId: validID("chanCrowd"), CreateAt: 1000}
	f := newPostReadersFixture(t, post, model.ChannelTypeOpen)

	readers := make([]string, 0, maxQueryReaders+3)
	for i := 0; i < maxQueryReaders+3; i++ {
		readerID := validID(fmt.Sprintf("mob%d", i))
		readers = append(readers, readerID)
		f.kv.set(rrKey(f.channelID, f.postID, readerID), mustJSON(t, int64(1500+i)))
	}
	f.kv.set(idxKey(f.channelID), mustJSON(t, readers))

	w := doPostReaders(f.plugin, mustJSON(t, postReadersRequest{PostID: f.postID}), f.authorID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp postReadersResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Len(t, resp.Readers, maxQueryReaders)
	assert.True(t, resp.Truncated)
}

func TestHandlePostReaders_IndexReadFailureReturns500(t *testing.T) {
	post := &model.Post{Id: validID("postIdxFail"), UserId: validID("authorIdxFail"), ChannelId: validID("chanIdxFail"), CreateAt: 1000}
	f := newPostReadersFixture(t, post, model.ChannelTypeGroup)

	f.kv.failGet = func(key string) *model.AppError {
		if key == idxKey(f.channelID) {
			return model.NewAppError("kv", "index read failed", nil, "", http.StatusInternalServerError)
		}
		return nil
	}

	w := doPostReaders(f.plugin, mustJSON(t, postReadersRequest{PostID: f.postID}), f.authorID)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestHandlePostReaders_RejectsBadInput(t *testing.T) {
	p, _ := setupTestPlugin(t)

	assert.Equal(t, http.StatusUnauthorized, doPostReaders(p, mustJSON(t, postReadersRequest{PostID: validID("postX")}), "").Code)
	assert.Equal(t, http.StatusBadRequest, doPostReaders(p, []byte("{not json"), validID("userX")).Code)
	assert.Equal(t, http.StatusBadRequest, doPostReaders(p, mustJSON(t, postReadersRequest{PostID: "short"}), validID("userX")).Code)
}
