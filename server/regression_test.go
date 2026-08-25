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

// validID returns a 26-character alphanumeric Mattermost id derived from tag.
func validID(tag string) string {
	s := tag
	out := []byte(s)
	i := 0
	for len(out) < 26 {
		out = append(out, "xabcdefghijklmnopqrstuvwxyz0123456789"[i%36])
		i++
	}
	return string(out)
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return b
}

func doRead(p *Plugin, body []byte, userID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/v1/read", bytes.NewReader(body))
	if userID != "" {
		req.Header.Set("Mattermost-User-Id", userID)
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)
	return w
}

func doQuery(p *Plugin, body []byte, userID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/v1/receipts/query", bytes.NewReader(body))
	if userID != "" {
		req.Header.Set("Mattermost-User-Id", userID)
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)
	return w
}

// --- Cross-channel receipt isolation ---------------------------------------

func TestHandleQuery_CrossChannelIsolation(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	userID := validID("userA")
	otherID := validID("userB")
	channelA := validID("chanA")
	channelB := validID("chanB")
	postSomewhereElse := validID("postB")

	// The other participant has read a post of DM B.
	kv.set(rrKey(channelB, postSomewhereElse, otherID), mustJSON(t, int64(5000)))
	_ = otherID

	channel := &model.Channel{Id: channelA, Type: model.ChannelTypeDirect}
	api.On("GetChannel", channelA).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelA, model.PermissionReadChannel).Return(true)
	api.On("GetChannelMembers", channelA, 0, 2).Return(model.ChannelMembers{
		{UserId: userID},
		{UserId: otherID},
	}, nil)

	// The requester asks for a post from DM B while querying DM A.
	body := mustJSON(t, queryRequest{ChannelID: channelA, PostIDs: []string{postSomewhereElse}})
	w := doQuery(p, body, userID)

	require.Equal(t, http.StatusOK, w.Code)
	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Empty(t, resp.Receipts, "a post from another channel must not leak a receipt")
}

// --- Monotonic watermark under concurrency ---------------------------------

func TestAdvanceWatermark_MonotonicUnderConcurrency(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	channelID := validID("chanC")
	readerID := validID("userR")

	const n = 50
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			post := &model.Post{
				Id:        validID(fmt.Sprintf("post%d", i)),
				UserId:    validID("author"),
				ChannelId: channelID,
				CreateAt:  int64(i*1000) + 1000, // strictly increasing per goroutine
			}
			_, err := p.advanceWatermark(channelID, readerID, post, int64(9000+i))
			if err != nil {
				t.Errorf("advanceWatermark: %v", err)
			}
		}(i)
	}
	wg.Wait()

	data := kv.get(wmKey(channelID, readerID))
	require.NotNil(t, data, "watermark must be written")
	var wm Watermark
	require.NoError(t, json.Unmarshal(data, &wm))

	// The final watermark must be the maximum create_at among all writers.
	require.Equal(t, int64(n*1000), wm.CreateAt, "watermark must never decrease under concurrency")
}

// --- Partial KV failures ----------------------------------------------------

func TestHandleQuery_ReceiptReadFailureReturns500WithoutPartialResponse(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	userID := validID("userQuery")
	otherID := validID("otherQuery")
	channelID := validID("channelQuery")
	firstPostID := validID("firstPost")
	failingPostID := validID("failingPost")
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("GetChannelMembers", channelID, 0, 2).Return(model.ChannelMembers{
		{UserId: userID},
		{UserId: otherID},
	}, nil)

	kv.set(rrKey(channelID, firstPostID, otherID), mustJSON(t, int64(1000)))
	kv.failGet = func(key string) *model.AppError {
		if key == rrKey(channelID, failingPostID, otherID) {
			return model.NewAppError("kv", "receipt read failed", nil, "", http.StatusInternalServerError)
		}
		return nil
	}

	w := doQuery(p, mustJSON(t, queryRequest{
		ChannelID: channelID,
		PostIDs:   []string{firstPostID, failingPostID},
	}), userID)

	require.Equal(t, http.StatusInternalServerError, w.Code)
	assert.NotContains(t, w.Body.String(), firstPostID, "a failed query must not serialize receipts read before the error")
}

func TestHandleQuery_WatermarkReadFailureReturns500(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	userID := validID("userWatermark")
	otherID := validID("otherWatermark")
	channelID := validID("channelWatermark")
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("GetChannelMembers", channelID, 0, 2).Return(model.ChannelMembers{
		{UserId: userID},
		{UserId: otherID},
	}, nil)

	kv.failGet = func(key string) *model.AppError {
		if key == wmKey(channelID, otherID) {
			return model.NewAppError("kv", "watermark read failed", nil, "", http.StatusInternalServerError)
		}
		return nil
	}

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID}), userID)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestHandleQuery_MissingReceiptReturns200(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	userID := validID("userMissing")
	otherID := validID("otherMissing")
	channelID := validID("channelMissing")
	postID := validID("missingPost")
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("GetChannelMembers", channelID, 0, 2).Return(model.ChannelMembers{
		{UserId: userID},
		{UserId: otherID},
	}, nil)

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{postID}}), userID)

	require.Equal(t, http.StatusOK, w.Code)
	var response queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&response))
	assert.Empty(t, response.Receipts)
}

func TestMarkAsRead_WatermarkKeepsFirstReceiptTimeAfterRetry(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything).Return()

	readerID := validID("readerRetry")
	channelID := validID("channelRetry")
	postID := validID("postRetry")
	post := &model.Post{Id: postID, UserId: validID("author"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}

	const firstReadAt int64 = 1000
	const retryAt int64 = 2000
	p.clock = func() int64 { return firstReadAt }
	failWatermark := true
	kv.failSet = func(key string) *model.AppError {
		if failWatermark && key == wmKey(channelID, readerID) {
			return model.NewAppError("kv", "watermark failed", nil, "", http.StatusInternalServerError)
		}
		return nil
	}

	_, err := p.markAsRead(readerID, post, channel)
	require.Error(t, err, "the receipt was written, but the failed watermark must fail the request")

	p.clock = func() int64 { return retryAt }
	failWatermark = false
	receipt, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)
	assert.Equal(t, firstReadAt, receipt.ReadAt, "the existing per-post receipt is the source of the retry time")

	var watermark Watermark
	require.NoError(t, json.Unmarshal(kv.get(wmKey(channelID, readerID)), &watermark))
	assert.Equal(t, firstReadAt, watermark.ReadAt, "a watermark retry must not move read_at forward")
}

func TestMarkAsRead_ReceiptWriteFailureLeavesWatermarkUntouched(t *testing.T) {
	p, api := setupTestPlugin(t)

	readerID := validID("userR")
	channelID := validID("chanW")
	postID := validID("postW")
	post := &model.Post{Id: postID, UserId: validID("author"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}

	// Receipt write fails hard.
	api.On("KVSetWithOptions", rrKey(channelID, postID, readerID), mock.Anything, mock.Anything).Return(false, model.NewAppError("kv", "boom", nil, "x", http.StatusInternalServerError))
	// We must also register KVGet (advanceWatermark would read it, but it must
	// not be reached); register a KVGet impl so plugintest does not panic if code
	// unexpectedly reads.
	api.On("KVGet", mock.Anything).Return(nil, nil)

	_, err := p.markAsRead(readerID, post, channel)
	require.Error(t, err)

	// Watermark must not have been touched.
	api.AssertNotCalled(t, "KVSetWithOptions", wmKey(channelID, readerID), mock.Anything, mock.Anything)
	api.AssertNotCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)
}

func TestHandleRead_ReceiptWriteFailureReturns500(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := validID("userA")
	readerID := validID("userB")
	postID := validID("postW2")
	channelID := validID("chanW2")
	post := &model.Post{Id: postID, UserId: readerID, ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}

	api.On("GetPost", postID).Return(post, nil)
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("KVGet", mock.Anything).Return(nil, nil)
	api.On("KVSetWithOptions", rrKey(channelID, postID, userID), mock.Anything, mock.Anything).Return(false, model.NewAppError("kv", "boom", nil, "", http.StatusInternalServerError))

	w := doRead(p, mustJSON(t, readRequest{PostID: postID}), userID)
	require.Equal(t, http.StatusInternalServerError, w.Code)
	api.AssertNotCalled(t, "KVSetWithOptions", wmKey(channelID, userID), mock.Anything, mock.Anything)
	api.AssertNotCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)
}

func TestHandleRead_WatermarkCASFailureReturns500WithoutWS(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := validID("userA")
	readerID := validID("userB")
	postID := validID("postW3")
	channelID := validID("chanW3")
	post := &model.Post{Id: postID, UserId: readerID, ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}

	api.On("GetPost", postID).Return(post, nil)
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	// Receipt write succeeds; watermark CAS always loses (conflict) -> exhausted.
	api.On("KVGet", mock.Anything).Return(nil, nil)
	api.On("KVSetWithOptions", rrKey(channelID, postID, userID), mock.Anything, mock.Anything).Return(true, nil)
	api.On("KVSetWithOptions", wmKey(channelID, userID), mock.Anything, mock.Anything).Return(false, nil)

	w := doRead(p, mustJSON(t, readRequest{PostID: postID}), userID)
	require.Equal(t, http.StatusInternalServerError, w.Code)
	api.AssertNotCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)
}

// --- Query limits and malformed input ---------------------------------------

func TestHandleQuery_MaxLimitOnlyFirst200(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	userID := validID("userA")
	otherID := validID("userB")
	channelID := validID("chanQ")

	for i := 0; i < maxQueryIDs+50; i++ {
		kv.set(rrKey(channelID, validID(fmt.Sprintf("post%03d", i)), otherID), mustJSON(t, int64(1000+i)))
	}

	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("GetChannelMembers", channelID, 0, 2).Return(model.ChannelMembers{{UserId: userID}, {UserId: otherID}}, nil)

	ids := make([]string, 0, maxQueryIDs+50)
	for i := 0; i < maxQueryIDs+50; i++ {
		ids = append(ids, validID(fmt.Sprintf("post%03d", i)))
	}
	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: ids}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Len(t, resp.Receipts, maxQueryIDs, "only the first 200 ids may be queried")
	// The 201st+ post must not be present.
	_, ok := resp.Receipts[validID(fmt.Sprintf("post%03d", maxQueryIDs))]
	assert.False(t, ok)
}

func TestHandleQuery_IgnoresInvalidPostIDs(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	userID := validID("userA")
	otherID := validID("userB")
	channelID := validID("chanINV")

	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("GetChannelMembers", channelID, 0, 2).Return(model.ChannelMembers{{UserId: userID}, {UserId: otherID}}, nil)

	// An invalid id like "post1" (not 26 chars) must be dropped, not queried.
	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{"post1", ""}}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Empty(t, resp.Receipts)
}

func TestHandleQuery_EmptyChannelID400(t *testing.T) {
	p, _ := setupTestPlugin(t)
	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: "", PostIDs: []string{"x"}}), validID("userA"))
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleQuery_Unauthorized(t *testing.T) {
	p, _ := setupTestPlugin(t)
	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: "ch", PostIDs: []string{"x"}}), "")
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestHandleRead_InvalidPostID400(t *testing.T) {
	p, _ := setupTestPlugin(t)
	w := doRead(p, mustJSON(t, readRequest{PostID: "nope"}), validID("userA"))
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleRead_BrokenJSON400(t *testing.T) {
	p, _ := setupTestPlugin(t)
	w := doRead(p, []byte("{ not json"), validID("userA"))
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleRead_BodyOverLimit400(t *testing.T) {
	p, _ := setupTestPlugin(t)
	huge := `{"post_id":"` + strings.Repeat("a", 64*1024+100) + `"}`
	w := doRead(p, []byte(huge), validID("userA"))
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

// --- Identity only from header ----------------------------------------------

func TestHandleRead_IgnoresUserIDInBody(t *testing.T) {
	p, api := setupTestPlugin(t)

	attacker := validID("attacker")
	postID := validID("postBodyID")
	channelID := validID("chanBody")
	post := &model.Post{Id: postID, UserId: validID("author"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}

	api.On("GetPost", postID).Return(post, nil)
	api.On("GetChannel", channelID).Return(channel, nil)
	// The identity must come from the header (attacker member), and the reader
	// recorded for the receipt must be `attacker`, not whatever the body said.
	api.On("HasPermissionToChannel", attacker, channelID, model.PermissionReadChannel).Return(true)
	api.On("KVGet", wmKey(channelID, attacker)).Return(nil, nil)
	api.On("KVSetWithOptions", wmKey(channelID, attacker), mock.Anything, mock.Anything).Return(true, nil)
	api.On("KVSetWithOptions", rrKey(channelID, postID, attacker), mock.Anything, mock.Anything).Return(true, nil)
	api.On("PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything).Return()

	// The body tries to smuggle a different user id.
	body := []byte(fmt.Sprintf(`{"post_id":"%s","user_id":"otheruser000000000000"}`, postID))
	req := httptest.NewRequest("POST", "/api/v1/read", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", attacker)
	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	api.AssertCalled(t, "KVGet", wmKey(channelID, attacker))
	api.AssertNotCalled(t, "KVGet", wmKey(channelID, "otheruser000000000000"))
}

// --- First-write-wins per-post receipt ---------------------------------------

func TestMarkAsRead_FirstWriteWins(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	readerID := validID("userR")
	channelID := validID("chanF")
	postID := validID("postF")
	post := &model.Post{Id: postID, UserId: validID("author"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}
	api.On("PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything).Return()

	first, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)
	require.True(t, first.ReadAt > 0)

	// Second read: the per-post receipt is first-write-wins, and the watermark
	// already covers the post, so no extra WS event and the read_at is unchanged.
	second, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)
	require.Equal(t, first.ReadAt, second.ReadAt)

	wsCalls := 0
	for _, c := range api.Calls {
		if c.Method == "PublishWebSocketEvent" {
			wsCalls++
		}
	}
	assert.Equal(t, 1, wsCalls, "only the first read publishes a WS event")
}

// --- The watermark is the authority on "already read" ------------------------

// A post the watermark already covers must keep its original read time even
// when its per-post receipt has expired by TTL. Otherwise a reader who merely
// scrolls past old messages after a Desktop restart would move the author's
// "Read HH:MM" indicator to today's time, and would emit a spurious WS event.
func TestMarkAsRead_ExpiredReceiptKeepsWatermarkTime(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)
	api.On("PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything).Return()

	readerID := validID("userR")
	channelID := validID("chanTTL")
	postID := validID("postTTL")
	oldPost := &model.Post{Id: postID, UserId: validID("author"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}

	// Everything up to create_at 5000 was read long ago, at 7777. The per-post
	// receipt for the old post is gone (TTL), only the watermark remains.
	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("newer"), CreateAt: 5000, ReadAt: 7777}))
	require.Nil(t, kv.get(rrKey(channelID, postID, readerID)))

	receipt, err := p.markAsRead(readerID, oldPost, channel)
	require.NoError(t, err)
	assert.Equal(t, int64(7777), receipt.ReadAt, "an already-read post must keep the watermark read time")

	assert.Nil(t, kv.get(rrKey(channelID, postID, readerID)), "no receipt may be written for an already-read post")
	api.AssertNotCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)

	var wm Watermark
	require.NoError(t, json.Unmarshal(kv.get(wmKey(channelID, readerID)), &wm))
	assert.Equal(t, int64(5000), wm.CreateAt, "the watermark must not move backwards")
	assert.Equal(t, int64(7777), wm.ReadAt)
}

// The exact time still wins over the watermark approximation while the per-post
// receipt is alive.
func TestMarkAsRead_CoveredPostPrefersStoredReceipt(t *testing.T) {
	kv := newFakeKV()
	p, api := setupTestPlugin(t)
	wireKV(api, kv)

	readerID := validID("userR")
	channelID := validID("chanEX")
	postID := validID("postEX")
	oldPost := &model.Post{Id: postID, UserId: validID("author"), ChannelId: channelID, CreateAt: 1000}
	channel := &model.Channel{Id: channelID, Type: model.ChannelTypeDirect}

	kv.set(wmKey(channelID, readerID), mustJSON(t, Watermark{PostID: validID("newer"), CreateAt: 5000, ReadAt: 7777}))
	kv.set(rrKey(channelID, postID, readerID), mustJSON(t, int64(4242)))

	receipt, err := p.markAsRead(readerID, oldPost, channel)
	require.NoError(t, err)
	assert.Equal(t, int64(4242), receipt.ReadAt, "the stored per-post receipt is the exact time")
}

// --- Self-DM ("personal notes") ---------------------------------------------

// Mattermost's self-DM is a type-D channel with a single member. Nobody else
// can read those posts, so the query must answer with an empty result instead
// of failing with 500 every time the channel is opened.
func TestHandleQuery_SelfDMReturnsEmptyResult(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := validID("userSelf")
	channelID := validID("chanSelf")

	api.On("GetChannel", channelID).Return(&model.Channel{Id: channelID, Type: model.ChannelTypeDirect}, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("GetChannelMembers", channelID, 0, 2).Return(model.ChannelMembers{{UserId: userID}}, nil)

	w := doQuery(p, mustJSON(t, queryRequest{ChannelID: channelID, PostIDs: []string{validID("postSelf")}}), userID)
	require.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	require.NoError(t, json.NewDecoder(w.Body).Decode(&resp))
	assert.Empty(t, resp.Receipts)
	assert.Nil(t, resp.Watermark)

	// No KV lookup is needed at all for a channel nobody else reads.
	api.AssertNotCalled(t, "KVGet", mock.Anything)
}
