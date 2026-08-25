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
			if _, err := p.ensureReaderIndexed(channelID, validID(fmt.Sprintf("rdr%d", i))); err != nil {
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

	added, err := p.ensureReaderIndexed(channelID, readerID)
	require.NoError(t, err)
	require.True(t, added)

	writes := 0
	kv.failSet = func(key string) *model.AppError {
		if key == idxKey(channelID) {
			writes++
		}
		return nil
	}
	added, err = p.ensureReaderIndexed(channelID, readerID)
	require.NoError(t, err)
	assert.False(t, added)
	assert.Zero(t, writes, "an already indexed reader must not be written again")
}

// A full index is a bounded-cost decision, not an error: the read still succeeds,
// the reader is simply not counted (documented residual risk).
func TestEnsureReaderIndexed_FullIndexOfMembersIsNotAnError(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanIdxFull")
	full := make([]string, 0, maxIndexReaders)
	for i := 0; i < maxIndexReaders; i++ {
		full = append(full, validID(fmt.Sprintf("full%d", i)))
	}
	kv.set(idxKey(channelID), mustJSON(t, full))
	stubMembers(api, channelID, full...)

	added, err := p.ensureReaderIndexed(channelID, validID("rdrOverflow"))
	require.NoError(t, err)
	assert.False(t, added)
	assert.Len(t, readIndex(t, kv, channelID), maxIndexReaders, "the index must stay capped and keep what it had")
}

// The index is append-only and never expires, so without pruning a channel with
// enough turnover would fill up with people who left and stop counting anyone new.
func TestEnsureReaderIndexed_PrunesDepartedReadersWhenFull(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanIdxChurn")
	stayed := make([]string, 0, maxIndexReaders)
	departed := make([]string, 0, 10)
	index := make([]string, 0, maxIndexReaders)
	for i := 0; i < maxIndexReaders; i++ {
		id := validID(fmt.Sprintf("churn%d", i))
		index = append(index, id)
		if i < 10 {
			departed = append(departed, id)
		} else {
			stayed = append(stayed, id)
		}
	}
	kv.set(idxKey(channelID), mustJSON(t, index))

	newcomer := validID("rdrNewcomer")
	stubMembers(api, channelID, append(append([]string{}, stayed...), newcomer)...)

	added, err := p.ensureReaderIndexed(channelID, newcomer)
	require.NoError(t, err)
	assert.True(t, added)

	stored := readIndex(t, kv, channelID)
	assert.Len(t, stored, len(stayed)+1)
	assert.Equal(t, newcomer, stored[len(stored)-1], "a live reader must get in once the departed ones are pruned")
	for _, gone := range departed {
		assert.NotContains(t, stored, gone, "a reader who left the channel must not keep occupying the index")
	}
}

// A reader who has left the channel must not have their read activity reported,
// even while they are still recorded in the index.
func TestChannelReaders_ExcludesDepartedReaders(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanChurnRead")
	stayed := validID("stayedReader")
	left := validID("leftReader")
	requester := validID("requesterChurn")
	kv.set(idxKey(channelID), mustJSON(t, []string{stayed, left, requester}))
	stubMembers(api, channelID, stayed, requester)

	page, err := p.channelReaders(channelID, requester, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{stayed}, page.ids)
	assert.False(t, page.truncated)
}

func TestChannelReaders_PagesThroughALargeIndex(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanPaged")
	readers := make([]string, 0, maxQueryReaders+7)
	for i := 0; i < maxQueryReaders+7; i++ {
		readers = append(readers, validID(fmt.Sprintf("paged%d", i)))
	}
	kv.set(idxKey(channelID), mustJSON(t, readers))
	stubAllMembers(api, channelID)

	first, err := p.channelReaders(channelID, "", 0)
	require.NoError(t, err)
	require.Len(t, first.ids, maxQueryReaders)
	require.True(t, first.truncated, "a full page must announce that more readers exist")
	require.Equal(t, maxQueryReaders, first.nextOffset)

	second, err := p.channelReaders(channelID, "", first.nextOffset)
	require.NoError(t, err)
	assert.Len(t, second.ids, 7, "the rest of the index must be reachable rather than silently dropped")
	assert.False(t, second.truncated)
	assert.Zero(t, second.nextOffset)
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
	api.On("PublishWebSocketEvent", wsEventReceiptsChanged, mock.Anything, mock.Anything).Return()

	channelID := validID("chanCovered")
	readerID := validID("rdrCovered")

	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("newerPost"), CreateAt: 5000, ReadAt: 5500}))

	post := &model.Post{Id: validID("olderPost"), UserId: validID("authorCovered"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	_, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)

	assert.Equal(t, []string{readerID}, readIndex(t, kv, channelID))
}

func TestMarkAsRead_PublishesSafeChannelInvalidationForWatermarkAdvance(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything).Return()

	channelID := validID("chanInvalidate")
	readerID := validID("readerInvalidate")
	authorID := validID("authorNewer")
	post := &model.Post{Id: validID("postNewer"), UserId: authorID, ChannelId: channelID, CreateAt: 200}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeGroup}

	_, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)

	var targeted, invalidation *mock.Call
	for i := range api.Calls {
		call := &api.Calls[i]
		if call.Method != "PublishWebSocketEvent" {
			continue
		}
		event := call.Arguments.Get(0)
		switch event {
		case wsEventReceipt:
			targeted = call
		case wsEventReceiptsChanged:
			invalidation = call
		}
	}
	require.NotNil(t, targeted, "the post author still receives the targeted receipt")
	require.NotNil(t, invalidation, "a watermark advance must invalidate all channel aggregates")

	targetedPayload := targeted.Arguments.Get(1).(map[string]interface{})
	assert.Equal(t, readerID, targetedPayload["reader_id"])
	assert.Equal(t, post.Id, targetedPayload["post_id"])
	assert.Equal(t, authorID, targeted.Arguments.Get(2).(*model.WebsocketBroadcast).UserId)

	payload := invalidation.Arguments.Get(1).(map[string]interface{})
	assert.Equal(t, map[string]interface{}{"channel_id": channelID}, payload)
	assert.NotContains(t, payload, "reader_id")
	assert.NotContains(t, payload, "post_id")
	assert.Equal(t, channelID, invalidation.Arguments.Get(2).(*model.WebsocketBroadcast).ChannelId)
}

func TestMarkAsRead_LegacyIndexedReaderPublishesInvalidation(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything).Return()

	channelID := validID("chanLegacyIndex")
	readerID := validID("readerLegacy")
	post := &model.Post{Id: validID("postLegacy"), UserId: validID("authorLegacy"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("newerLegacy"), CreateAt: 5000, ReadAt: 6000}))

	_, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)
	assert.Equal(t, []string{readerID}, readIndex(t, kv, channelID))

	invalidations := 0
	for _, call := range api.Calls {
		if call.Method != "PublishWebSocketEvent" || call.Arguments.Get(0) != wsEventReceiptsChanged {
			continue
		}
		invalidations++
		payload := call.Arguments.Get(1).(map[string]interface{})
		assert.Equal(t, map[string]interface{}{"channel_id": channelID}, payload)
		assert.NotContains(t, payload, "reader_id")
		assert.NotContains(t, payload, "post_id")
	}
	assert.Equal(t, 1, invalidations)
	api.AssertNotCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)
}

func TestMarkAsRead_CoveredIndexedReaderDoesNotInvalidateAgain(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything).Return()

	channelID := validID("chanAlreadyIndex")
	readerID := validID("readerAlready")
	post := &model.Post{Id: validID("postAlready"), UserId: validID("authorAlready"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	kv.set(idxKey(channelID), mustJSON(t, []string{readerID}))
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("newerAlready"), CreateAt: 5000, ReadAt: 6000}))

	_, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)
	api.AssertNotCalled(t, "PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything)
}

func TestMarkAsRead_NewReaderAdvancesWatermarkWithOneInvalidation(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything).Return()

	channelID := validID("chanNewIndex")
	readerID := validID("readerNew")
	post := &model.Post{Id: validID("postNewIndex"), UserId: validID("authorNewIndex"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}

	_, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)

	invalidations := 0
	for _, call := range api.Calls {
		if call.Method == "PublishWebSocketEvent" && call.Arguments.Get(0) == wsEventReceiptsChanged {
			invalidations++
		}
	}
	assert.Equal(t, 1, invalidations)
	api.AssertCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)
}

func TestMarkAsRead_LegacyReaderAdvancesWatermarkBeforeInvalidation(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything).Return()

	channelID := validID("chanLegacyNewer")
	readerID := validID("readerLegacyNewer")
	post := &model.Post{Id: validID("postLegacyNewer"), UserId: validID("authorLegacyNewer"), ChannelId: channelID, CreateAt: 2000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("legacyOlder"), CreateAt: 1000, ReadAt: 1500}))

	_, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)
	assert.Equal(t, []string{readerID}, readIndex(t, kv, channelID))

	var watermark Watermark
	require.NoError(t, json.Unmarshal(kv.get(wmKey(channelID, readerID)), &watermark))
	assert.Equal(t, int64(2000), watermark.CreateAt)

	invalidations := 0
	watermarkWrite := -1
	invalidation := -1
	for i, call := range api.Calls {
		if call.Method == "KVSetWithOptions" && call.Arguments.Get(0) == wmKey(channelID, readerID) {
			watermarkWrite = i
		}
		if call.Method == "PublishWebSocketEvent" && call.Arguments.Get(0) == wsEventReceiptsChanged {
			invalidations++
			invalidation = i
			payload := call.Arguments.Get(1).(map[string]interface{})
			assert.Equal(t, map[string]interface{}{"channel_id": channelID}, payload)
			assert.NotContains(t, payload, "reader_id")
			assert.NotContains(t, payload, "post_id")
		}
	}
	assert.Equal(t, 1, invalidations)
	assert.Greater(t, watermarkWrite, -1)
	assert.Greater(t, invalidation, watermarkWrite, "the refresh signal must observe the final watermark")
	api.AssertCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)
}

func TestMarkAsRead_LegacyIndexInvalidatesWhenNewerReceiptWriteFails(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything).Return()

	channelID := validID("chanLegacyFailure")
	readerID := validID("readerLegacyFailure")
	post := &model.Post{Id: validID("postLegacyFailure"), UserId: validID("authorLegacyFailure"), ChannelId: channelID, CreateAt: 2000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	old := Watermark{PostID: validID("legacyFailureOlder"), CreateAt: 1000, ReadAt: 1500}
	kv.set(wmKey(channelID, readerID), mustJSON(t, old))
	kv.failSet = func(key string) *model.AppError {
		if key == rrKey(channelID, post.Id, readerID) {
			return model.NewAppError("kv", "receipt failed", nil, "", http.StatusInternalServerError)
		}
		return nil
	}

	_, err := p.markAsRead(readerID, post, channel)
	require.Error(t, err)
	assert.Equal(t, []string{readerID}, readIndex(t, kv, channelID))
	assert.Equal(t, mustJSON(t, old), kv.get(wmKey(channelID, readerID)))

	invalidations := 0
	for _, call := range api.Calls {
		if call.Method == "PublishWebSocketEvent" && call.Arguments.Get(0) == wsEventReceiptsChanged {
			invalidations++
		}
	}
	assert.Equal(t, 1, invalidations)
	api.AssertNotCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)
}

func TestWatermarkAdvanceEventuallyRefreshesOlderPostsOfOtherAuthors(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes
	api.On("PublishWebSocketEvent", mock.Anything, mock.Anything, mock.Anything).Return()

	channelID := validID("chanWatermarkRefresh")
	authorA := validID("authorOlder")
	authorB := validID("authorNewer")
	readerC := validID("readerAdvances")
	older := &model.Post{Id: validID("postOlder"), UserId: authorA, ChannelId: channelID, CreateAt: 100}
	newer := &model.Post{Id: validID("postNewer"), UserId: authorB, ChannelId: channelID, CreateAt: 200}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeGroup}

	_, err := p.markAsRead(readerC, newer, channel)
	require.NoError(t, err)

	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", authorA, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID, older, newer)
	stubAllMembers(api, channelID)
	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{older.Id}}), authorA)
	require.Equal(t, http.StatusOK, w.Code)

	var response queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&response))
	assert.Equal(t, 1, response.Posts[older.Id].Count,
		"the refreshed aggregate must apply reader C's newer watermark to author A's older post")
}

// --- Group query ------------------------------------------------------------

func TestHandleQuery_GroupCountsReadersWithoutExposingThem(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes

	userID := validID("authorGroup")
	readerA := validID("groupA")
	readerB := validID("groupB")
	channelID := validID("chanGroupQ")
	newPost := &model.Post{Id: validID("pNew"), UserId: userID, ChannelId: channelID, CreateAt: 2000}
	oldPost := &model.Post{Id: validID("pOld"), UserId: userID, ChannelId: channelID, CreateAt: 500}

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeGroup}, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID, newPost, oldPost)
	stubAllMembers(api, channelID)

	// The requester is in the index too — they read other people's posts here.
	kv.set(idxKey(channelID), mustJSON(t, []string{readerA, userID, readerB}))
	kv.set(wmKey(channelID, readerA), mustJSON(t, Watermark{PostID: newPost.Id, CreateAt: 3000, ReadAt: 3100}))
	kv.set(wmKey(channelID, readerB), mustJSON(t, Watermark{PostID: oldPost.Id, CreateAt: 1000, ReadAt: 1100}))
	kv.set(wmKey(channelID, userID), mustJSON(t, Watermark{PostID: validID("pSelf"), CreateAt: 9000, ReadAt: 9100}))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{newPost.Id, oldPost.Id}}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	body := w.Body.String()
	require.NoError(t, json.Unmarshal([]byte(body), &resp))

	assert.Equal(t, 1, resp.Posts[newPost.Id].Count, "only reader A has read past the newer post")
	assert.Equal(t, 2, resp.Posts[oldPost.Id].Count, "both readers have read past the older post")
	assert.False(t, resp.Truncated)

	// The response must not carry per-reader read positions in any form: those are
	// channel-wide and would let a member reconstruct who read what and when.
	for _, id := range []string{readerA, readerB, userID} {
		assert.NotContains(t, body, id, "the response must not name channel readers")
	}
	assert.NotContains(t, body, "watermark")
}

// Exact per-post receipts cost one read per post per reader, so they are served
// only for a single-reader channel — in practice a DM, which is where v0.1.0
// promised them. Authorship is enforced separately, so this is a cost rule.
func TestHandleQuery_ExactTimeOnlyForASingleReader(t *testing.T) {
	setup := func(t *testing.T, readers []string) (queryResponse, string) {
		t.Helper()
		kv := newFakeKV()
		p, api := setupTestPlugin(t)
		wireKV(api, kv)
		p.configuration.EnabledChannelTypes = allChannelTypes

		userID := validID("authorExact")
		channelID := validID("chanExact")
		post := &model.Post{Id: validID("sharedPost"), UserId: userID, ChannelId: channelID, CreateAt: 1000}
		api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeGroup}, nil)
		api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
		stubChannelPosts(api, channelID, post)
		stubAllMembers(api, channelID)

		kv.set(idxKey(channelID), mustJSON(t, readers))
		for _, readerID := range readers {
			kv.set(rrKey(channelID, post.Id, readerID), mustJSON(t, int64(4200)))
			kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: post.Id, CreateAt: 1000, ReadAt: 4200}))
		}

		w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{post.Id}}), userID)
		require.Equal(t, http.StatusOK, w.Code)
		var resp queryResponse
		require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
		return resp, post.Id
	}

	resp, postID := setup(t, []string{validID("soleReader")})
	assert.Equal(t, int64(4200), resp.Posts[postID].ReadAt, "a single reader keeps the exact v0.1 contract")

	resp, postID = setup(t, []string{validID("manyA"), validID("manyB")})
	assert.Equal(t, 2, resp.Posts[postID].Count)
	assert.Zero(t, resp.Posts[postID].ReadAt, "more than one reader must not trigger a read per post per reader")
}

func TestHandleQuery_ReportsATruncatedCountAsALowerBound(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes

	userID := validID("authorTrunc")
	channelID := validID("chanTrunc")
	post := &model.Post{Id: validID("crowdPost"), UserId: userID, ChannelId: channelID, CreateAt: 500}
	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeOpen}, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID, post)
	stubAllMembers(api, channelID)

	readers := make([]string, 0, maxQueryReaders+5)
	for i := 0; i < maxQueryReaders+5; i++ {
		readerID := validID(fmt.Sprintf("crowd%d", i))
		readers = append(readers, readerID)
		kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: post.Id, CreateAt: 1000, ReadAt: 1100}))
	}
	kv.set(idxKey(channelID), mustJSON(t, readers))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{post.Id}}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Equal(t, maxQueryReaders, resp.Posts[post.Id].Count)
	assert.True(t, resp.Truncated, "a capped reader list must say so instead of passing a prefix off as the whole channel")
	assert.True(t, resp.Posts[post.Id].Truncated)
}

// --- Authorization ----------------------------------------------------------

func TestHandleQuery_RefusesToAnswerAboutAnotherAuthorsPost(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes

	memberA := validID("memberA")
	authorB := validID("authorB")
	readerC := validID("readerC")
	channelID := validID("chanForeign")
	foreign := &model.Post{Id: validID("postOfB"), UserId: authorB, ChannelId: channelID, CreateAt: 1000}
	mine := &model.Post{Id: validID("postOfA"), UserId: memberA, ChannelId: channelID, CreateAt: 1000}

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeGroup}, nil)
	api.On("HasPermissionToChannel", memberA, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID, foreign, mine)
	stubAllMembers(api, channelID)

	kv.set(idxKey(channelID), mustJSON(t, []string{readerC}))
	kv.set(wmKey(channelID, readerC), mustJSON(t, Watermark{PostID: foreign.Id, CreateAt: 5000, ReadAt: 5100}))
	kv.set(rrKey(channelID, foreign.Id, readerC), mustJSON(t, int64(5100)))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{foreign.Id, mine.Id}}), memberA)
	require.Equal(t, http.StatusOK, w.Code, "a member may still ask about the channel; they just get nothing about someone else's post")

	var resp queryResponse
	body := w.Body.String()
	require.NoError(t, json.Unmarshal([]byte(body), &resp))

	_, leaked := resp.Posts[foreign.Id]
	assert.False(t, leaked, "the read state of another member's post must not be reported")
	assert.NotContains(t, body, readerC, "the reader of another member's post must not be named")
	assert.Equal(t, 1, resp.Posts[mine.Id].Count, "the caller still sees the status of their own post")
}

func TestHandleQuery_ForeignChannelPostIDIsIgnored(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes

	userID := validID("authorCross")
	readerID := validID("readerCross")
	channelID := validID("chanHere")
	otherChannelID := validID("chanThere")
	// The caller authored it, but in a different channel; paging this channel
	// never returns it, so it can never be answered.
	elsewhere := validID("postElsewhere")

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeGroup}, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID)
	stubAllMembers(api, channelID)

	kv.set(idxKey(channelID), mustJSON(t, []string{readerID}))
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("pw"), CreateAt: 9000, ReadAt: 9100}))
	kv.set(rrKey(otherChannelID, elsewhere, readerID), mustJSON(t, int64(9100)))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{elsewhere}}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Empty(t, resp.Posts)
}

// Channel scope is structural — posts only ever come from paging *this* channel —
// but the explicit check is kept as defence in depth, so it gets a test that
// exercises it directly: a post claiming a different channel is dropped even when
// the channel listing hands it over.
func TestHandleQuery_PostClaimingAnotherChannelIsDropped(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes

	userID := validID("authorScope")
	readerID := validID("readerScope")
	channelID := validID("chanScope")
	mislabelled := &model.Post{Id: validID("postScope"), UserId: userID, ChannelId: validID("chanOther"), CreateAt: 1000}

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeGroup}, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID, mislabelled)
	stubAllMembers(api, channelID)
	kv.set(idxKey(channelID), mustJSON(t, []string{readerID}))
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: mislabelled.Id, CreateAt: 5000, ReadAt: 5100}))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{mislabelled.Id}}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Empty(t, resp.Posts)
}

func TestHandleQuery_DeletedOwnPostGetsNoStatus(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes

	userID := validID("authorDel")
	readerID := validID("readerDel")
	channelID := validID("chanDel")
	deleted := &model.Post{Id: validID("postDel"), UserId: userID, ChannelId: channelID, CreateAt: 1000, DeleteAt: 2000}

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeGroup}, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID, deleted)
	stubAllMembers(api, channelID)
	kv.set(idxKey(channelID), mustJSON(t, []string{readerID}))
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: deleted.Id, CreateAt: 5000, ReadAt: 5100}))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{deleted.Id}}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Empty(t, resp.Posts)
}

// --- Channel types ----------------------------------------------------------

func TestChannelTypes_OnlyDirectIsEnabledOutOfTheBox(t *testing.T) {
	// v0.1.0 collected receipts in direct messages only. Upgrading must not
	// silently start collecting them across every group, private and open channel
	// of an installation, so anything beyond D is an explicit decision.
	valid, _ := (&configuration{ReceiptRetentionDays: 30}).validate()
	assert.Equal(t, "D", valid.EnabledChannelTypes)

	for _, channelType := range []string{"G", "P", "O"} {
		assert.False(t, valid.channelTypeEnabled(channelType), "%s must be off until an administrator turns it on", channelType)
	}
	assert.True(t, valid.channelTypeEnabled("D"))
}

func TestValidate_ChannelTypesAreConfigurable(t *testing.T) {
	types := []model.ChannelType{
		model.ChannelTypeDirect,
		model.ChannelTypeGroup,
		model.ChannelTypePrivate,
		model.ChannelTypeOpen,
	}

	for _, channelType := range types {
		t.Run(string(channelType)+" allowed when configured", func(t *testing.T) {
			p, api := setupTestPlugin(t)
			p.configuration.EnabledChannelTypes = allChannelTypes
			userID := validID("userTypes")
			channelID := validID("chanTypes")
			api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: channelType}, nil)
			api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)

			w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID}), userID)
			assert.Equal(t, http.StatusOK, w.Code)
		})

		t.Run(string(channelType)+" refused when excluded", func(t *testing.T) {
			p, api := setupTestPlugin(t)
			excluded := normalizeChannelTypes(strings.ReplaceAll(allChannelTypes, string(channelType), ""))
			require.NotEmpty(t, excluded)
			p.configuration.EnabledChannelTypes = excluded
			userID := validID("userTypes")
			channelID := validID("chanTypes")
			api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: channelType}, nil)

			w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID}), userID)
			assert.Equal(t, http.StatusForbidden, w.Code)

			post := &model.Post{Id: validID("postTypes"), UserId: validID("otherTypes"), ChannelId: channelID, CreateAt: 1000}
			api.On("GetPost", post.Id).Return(post, nil)
			assert.Equal(t, http.StatusForbidden, doRead(p, mustJSON(t, readRequest{PostID: post.Id}), userID).Code)
			assert.Equal(t, http.StatusForbidden, doPostReaders(p, mustJSON(t, postReadersRequest{PostID: post.Id}), userID).Code)
		})
	}
}

func TestHandleConfig_ReportsTheEnabledChannelTypes(t *testing.T) {
	p, _ := setupTestPlugin(t)
	p.configuration.EnabledChannelTypes = "DG"

	req := httptest.NewRequest("GET", "/api/v1/config", nil)
	req.Header.Set("Mattermost-User-Id", validID("userCfg"))
	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var resp configResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Equal(t, "DG", resp.EnabledChannelTypes)

	anon := httptest.NewRequest("GET", "/api/v1/config", nil)
	anonW := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, anonW, anon)
	assert.Equal(t, http.StatusUnauthorized, anonW.Code)
}

func TestHandleConfig_FallsBackToTheDefaultWhenUnset(t *testing.T) {
	p, _ := setupTestPlugin(t)
	p.configuration.EnabledChannelTypes = ""

	req := httptest.NewRequest("GET", "/api/v1/config", nil)
	req.Header.Set("Mattermost-User-Id", validID("userCfg"))
	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	var resp configResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Equal(t, defaultChannelTypes, resp.EnabledChannelTypes)
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

	p.configuration.EnabledChannelTypes = allChannelTypes
	api.On("GetPost", post.Id).Return(post, nil)
	api.On("GetChannel", post.ChannelId).Return(&model.Channel{Id: post.ChannelId, Type: channelType}, nil)
	api.On("HasPermissionToChannel", mock.Anything, post.ChannelId, model.PermissionReadChannel).Return(true)
	stubAllMembers(api, post.ChannelId)

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
	assert.True(t, resp.Truncated, "a capped list must say so rather than look complete")
	assert.Equal(t, maxQueryReaders, resp.NextOffset, "the rest of the readers must stay reachable")
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

// --- Security: no read state of someone else's message -----------------------

// The detail endpoint is the only way to learn *who* read a post, and it belongs
// to the author alone — in every channel type, including the ones where every
// member can see the message itself.
func TestHandlePostReaders_MemberCannotLearnWhoReadAnotherAuthorsPost(t *testing.T) {
	for _, channelType := range []model.ChannelType{model.ChannelTypeGroup, model.ChannelTypePrivate, model.ChannelTypeOpen} {
		t.Run(string(channelType), func(t *testing.T) {
			post := &model.Post{Id: validID("postAuthored"), UserId: validID("theAuthor"), ChannelId: validID("chanNosy"), CreateAt: 1000}
			f := newPostReadersFixture(t, post, channelType)

			readerID := validID("someReader")
			f.kv.set(idxKey(f.channelID), mustJSON(t, []string{readerID}))
			f.kv.set(rrKey(f.channelID, f.postID, readerID), mustJSON(t, int64(1500)))

			w := doPostReaders(f.plugin, mustJSON(t, postReadersRequest{PostID: f.postID}), validID("nosyMember"))

			require.Equal(t, http.StatusForbidden, w.Code)
			assert.NotContains(t, w.Body.String(), readerID)
		})
	}
}

// The query endpoint must not become a side channel for the same question: a
// member of the channel gets nothing about a post they did not write, and in
// particular cannot recover another member's read position from the response.
func TestHandleQuery_MemberCannotDeriveForeignReadState(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes

	snooper := validID("snooper")
	author := validID("otherAuthor")
	readerB := validID("readerB")
	readerC := validID("readerC")
	channelID := validID("chanSnoop")
	theirPost := &model.Post{Id: validID("theirPost"), UserId: author, ChannelId: channelID, CreateAt: 1000}

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeOpen}, nil)
	api.On("HasPermissionToChannel", snooper, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID, theirPost)
	stubAllMembers(api, channelID)

	kv.set(idxKey(channelID), mustJSON(t, []string{readerB, readerC}))
	kv.set(wmKey(channelID, readerB), mustJSON(t, Watermark{PostID: theirPost.Id, CreateAt: 4000, ReadAt: 4100}))
	kv.set(wmKey(channelID, readerC), mustJSON(t, Watermark{PostID: theirPost.Id, CreateAt: 6000, ReadAt: 6100}))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{theirPost.Id}}), snooper)
	require.Equal(t, http.StatusOK, w.Code)

	body := w.Body.String()
	var resp queryResponse
	require.NoError(t, json.Unmarshal([]byte(body), &resp))

	assert.Empty(t, resp.Posts, "no status at all for a post the caller did not write")
	for _, id := range []string{readerB, readerC} {
		assert.NotContains(t, body, id, "reader identities must never reach a non-author")
	}
	for _, stamp := range []string{"4000", "4100", "6000", "6100"} {
		assert.NotContains(t, body, stamp, "read positions must never reach a non-author")
	}
}

// A post the caller really did write, in a channel they really are in, is the one
// case that must keep working.
func TestHandleQuery_AuthorSeesTheStatusOfTheirOwnPost(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	p.configuration.EnabledChannelTypes = allChannelTypes

	author := validID("realAuthor")
	readerID := validID("realReader")
	channelID := validID("chanOwn")
	post := &model.Post{Id: validID("ownPost"), UserId: author, ChannelId: channelID, CreateAt: 1000}

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypePrivate}, nil)
	api.On("HasPermissionToChannel", author, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID, post)
	stubAllMembers(api, channelID)

	kv.set(idxKey(channelID), mustJSON(t, []string{readerID}))
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: post.Id, CreateAt: 3000, ReadAt: 3100}))

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{post.Id}}), author)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Equal(t, 1, resp.Posts[post.Id].Count)
}
