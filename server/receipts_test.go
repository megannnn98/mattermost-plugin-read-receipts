package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func TestMarkAsRead_WatermarkCreated(t *testing.T) {
	p, api := setupTestPlugin(t)

	readerID := "reader1xabcdefghijklmnopqr"
	channelID := "channel1xabcdefghijklmnopq"
	postID := "post1xabcdefghijklmnopqrst"

	post := &model.Post{
		Id:        postID,
		UserId:    "author1xabcdefghijklmnopqr",
		ChannelId: channelID,
		CreateAt:  1000,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}
	api.On("KVGet", idxKey(channelID)).Return(nil, nil)
	api.On("KVSetWithOptions", idxKey(channelID), mock.Anything, mock.Anything).Return(true, nil)

	api.On("KVGet", wmKey(channelID, readerID)).Return(nil, nil)
	api.On("KVSetWithOptions", wmKey(channelID, readerID), mock.Anything, mock.Anything).Return(true, nil)
	api.On("KVSetWithOptions", rrKey(channelID, postID, readerID), mock.Anything, mock.Anything).Return(true, nil)
	api.On("PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything).Return()

	receipt, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)
	require.NotNil(t, receipt)

	assert.Equal(t, postID, receipt.PostID)
	assert.Equal(t, channelID, receipt.ChannelID)
	assert.True(t, receipt.ReadAt > 0)
}

func TestMarkAsRead_WatermarkMonotonicity(t *testing.T) {
	p, api := setupTestPlugin(t)

	readerID := "reader1xabcdefghijklmnopqr"
	channelID := "channel1xabcdefghijklmnopq"
	oldPostID := "postoldxabcdefghijklmnopqr"
	newPostID := "postnewxabcdefghijklmnopqr"

	existingWM := &Watermark{
		PostID:   newPostID,
		CreateAt: 2000,
		ReadAt:   5000,
	}
	wmData, _ := json.Marshal(existingWM)

	oldPost := &model.Post{
		Id:        oldPostID,
		UserId:    "author1xabcdefghijklmnopqr",
		ChannelId: channelID,
		CreateAt:  1000,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}
	indexData, _ := json.Marshal([]string{readerID})
	api.On("KVGet", idxKey(channelID)).Return(indexData, nil)

	api.On("KVGet", wmKey(channelID, readerID)).Return(wmData, nil)
	// The watermark already covers this post, so markAsRead reads the stored
	// per-post receipt (absent here) instead of writing anything.
	api.On("KVGet", rrKey(channelID, oldPostID, readerID)).Return(nil, nil)

	api.On("PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything).Return()

	receipt, err := p.markAsRead(readerID, oldPost, channel)
	require.NoError(t, err)
	require.NotNil(t, receipt)

	kvSetCalls := api.Calls
	watermarkSetCalled := false
	for _, call := range kvSetCalls {
		if call.Method == "KVSetWithOptions" && len(call.Arguments) > 0 {
			if key, ok := call.Arguments[0].(string); ok && key == wmKey(channelID, readerID) {
				watermarkSetCalled = true
			}
		}
	}

	assert.False(t, watermarkSetCalled, "watermark should not be rolled back to older post")
}

func TestMarkAsRead_Idempotency(t *testing.T) {
	p, api := setupTestPlugin(t)

	readerID := "reader1xabcdefghijklmnopqr"
	channelID := "channel1xabcdefghijklmnopq"
	postID := "post1xabcdefghijklmnopqrst"

	existingWM := &Watermark{
		PostID:   postID,
		CreateAt: 1000,
		ReadAt:   5000,
	}
	wmData, _ := json.Marshal(existingWM)

	post := &model.Post{
		Id:        postID,
		UserId:    "author1xabcdefghijklmnopqr",
		ChannelId: channelID,
		CreateAt:  1000,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}
	indexData, _ := json.Marshal([]string{readerID})
	api.On("KVGet", idxKey(channelID)).Return(indexData, nil)

	api.On("KVGet", wmKey(channelID, readerID)).Return(wmData, nil)
	api.On("KVSetWithOptions", rrKey(channelID, postID, readerID), mock.Anything, mock.Anything).Return(false, nil)
	rrData, _ := json.Marshal(existingWM.ReadAt)
	api.On("KVGet", rrKey(channelID, postID, readerID)).Return(rrData, nil)

	receipt, err := p.markAsRead(readerID, post, channel)
	require.NoError(t, err)
	require.NotNil(t, receipt)
	assert.Equal(t, existingWM.ReadAt, receipt.ReadAt, "idempotent read must report the stored read time")

	wsCalls := 0
	for _, call := range api.Calls {
		if call.Method == "PublishWebSocketEvent" {
			wsCalls++
		}
	}
	assert.Equal(t, 0, wsCalls, "WS event should not be published on idempotent read")
}

func TestHandleQuery_Success(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := "user1xabcdefghijklmnopqrst"
	otherUserID := "user2xabcdefghijklmnopqrst"
	channelID := "channel1xabcdefghijklmnopq"
	postID1 := "post1xabcdefghijklmnopqrst"
	postID2 := "post2xabcdefghijklmnopqrst"

	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	stubChannelPosts(api, channelID,
		&model.Post{Id: postID1, UserId: userID, ChannelId: channelID, CreateAt: 1000},
		&model.Post{Id: postID2, UserId: userID, ChannelId: channelID, CreateAt: 2000},
	)
	stubAllMembers(api, channelID)
	indexData, _ := json.Marshal([]string{otherUserID})
	api.On("KVGet", idxKey(channelID)).Return(indexData, nil)

	wm := &Watermark{
		PostID:   postID2,
		CreateAt: 2000,
		ReadAt:   5000,
	}
	wmData, _ := json.Marshal(wm)
	api.On("KVGet", wmKey(channelID, otherUserID)).Return(wmData, nil)

	readAt1 := int64(4000)
	readAtData1, _ := json.Marshal(readAt1)
	api.On("KVGet", rrKey(channelID, postID1, otherUserID)).Return(readAtData1, nil)

	api.On("KVGet", rrKey(channelID, postID2, otherUserID)).Return(nil, nil)

	body, _ := json.Marshal(queryRequest{
		ChannelID: channelID,
		PostIDs:   []string{postID1, postID2},
	})
	req := httptest.NewRequest("POST", "/api/v1/receipts/query", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", userID)

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp queryResponse
	err := json.NewDecoder(w.Body).Decode(&resp)
	require.NoError(t, err)

	// The single reader's watermark covers both posts, and a single-reader channel
	// still gets the exact time from the per-post receipt where one survives.
	assert.Equal(t, 1, resp.Posts[postID1].Count)
	assert.Equal(t, readAt1, resp.Posts[postID1].ReadAt)
	assert.Equal(t, 1, resp.Posts[postID2].Count)
	assert.Zero(t, resp.Posts[postID2].ReadAt, "post2 has no explicit receipt; it is only covered by the watermark")
	assert.False(t, resp.Truncated)
}

func TestHandleQuery_NonDM(t *testing.T) {
	p, api := setupTestPlugin(t)
	p.configuration.EnabledChannelTypes = "D"

	userID := "user1xabcdefghijklmnopqrst"
	channelID := "channel1xabcdefghijklmnopq"

	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeOpen,
	}

	api.On("GetChannel", channelID).Return(channel, nil)

	body, _ := json.Marshal(queryRequest{
		ChannelID: channelID,
		PostIDs:   []string{"post1xabcdefghijklmnopqrst"},
	})
	req := httptest.NewRequest("POST", "/api/v1/receipts/query", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", userID)

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}
