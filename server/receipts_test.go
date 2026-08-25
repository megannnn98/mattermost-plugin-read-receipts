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

	readerID := "reader1"
	channelID := "channel1"
	postID := "post1"

	post := &model.Post{
		Id:        postID,
		UserId:    "author1",
		ChannelId: channelID,
		CreateAt:  1000,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

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

	readerID := "reader1"
	channelID := "channel1"
	oldPostID := "post_old"
	newPostID := "post_new"

	existingWM := &Watermark{
		PostID:   newPostID,
		CreateAt: 2000,
		ReadAt:   5000,
	}
	wmData, _ := json.Marshal(existingWM)

	oldPost := &model.Post{
		Id:        oldPostID,
		UserId:    "author1",
		ChannelId: channelID,
		CreateAt:  1000,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

	api.On("KVGet", wmKey(channelID, readerID)).Return(wmData, nil)
	api.On("KVSetWithOptions", rrKey(channelID, oldPostID, readerID), mock.Anything, mock.Anything).Return(true, nil)

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

	readerID := "reader1"
	channelID := "channel1"
	postID := "post1"

	existingWM := &Watermark{
		PostID:   postID,
		CreateAt: 1000,
		ReadAt:   5000,
	}
	wmData, _ := json.Marshal(existingWM)

	post := &model.Post{
		Id:        postID,
		UserId:    "author1",
		ChannelId: channelID,
		CreateAt:  1000,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

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

	userID := "user1"
	otherUserID := "user2"
	channelID := "channel1"
	postID1 := "post1"
	postID2 := "post2"

	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("GetChannelMembers", channelID, 0, 2).Return(model.ChannelMembers{
		{UserId: userID},
		{UserId: otherUserID},
	}, nil)

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

	require.NotNil(t, resp.Watermark)
	assert.Equal(t, postID2, resp.Watermark.PostID)
	assert.Equal(t, int64(2000), resp.Watermark.CreateAt)

	require.NotNil(t, resp.Receipts)
	assert.Equal(t, readAt1, resp.Receipts[postID1])
	_, hasPost2 := resp.Receipts[postID2]
	assert.False(t, hasPost2, "post2 should not have explicit receipt (covered by watermark)")
}

func TestHandleQuery_NonDM(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := "user1"
	channelID := "channel1"

	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeOpen,
	}

	api.On("GetChannel", channelID).Return(channel, nil)

	body, _ := json.Marshal(queryRequest{
		ChannelID: channelID,
		PostIDs:   []string{"post1"},
	})
	req := httptest.NewRequest("POST", "/api/v1/receipts/query", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", userID)

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}
