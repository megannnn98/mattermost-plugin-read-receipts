package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func setupTestPlugin(t *testing.T) (*Plugin, *plugintest.API) {
	api := &plugintest.API{}
	p := &Plugin{}
	p.API = api
	p.client = nil
	p.router = http.NewServeMux()
	p.registerRoutes()
	p.configMu.Lock()
	p.configuration = &configuration{
		EnableDebugLogging:   false,
		ReceiptRetentionDays: 30,
		EnabledChannelTypes:  defaultChannelTypes,
	}
	p.configMu.Unlock()
	return p, api
}

func TestHandleRead_Success(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := "user1xabcdefghijklmnopqrst"
	postID := "post1xabcdefghijklmnopqrst"
	channelID := "channel1xabcdefghijklmnopq"

	post := &model.Post{
		Id:        postID,
		UserId:    "user2xabcdefghijklmnopqrst",
		ChannelId: channelID,
		CreateAt:  1000,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

	api.On("GetPost", postID).Return(post, nil)
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	api.On("KVGet", idxKey(channelID)).Return(nil, nil)
	api.On("KVSetWithOptions", idxKey(channelID), mock.Anything, mock.Anything).Return(true, nil)

	api.On("KVGet", wmKey(channelID, userID)).Return(nil, nil)
	api.On("KVSetWithOptions", wmKey(channelID, userID), mock.Anything, mock.Anything).Return(true, nil)
	api.On("KVSetWithOptions", rrKey(channelID, postID, userID), mock.Anything, mock.Anything).Return(true, nil)

	api.On("PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything).Return()

	body, _ := json.Marshal(readRequest{PostID: postID})
	req := httptest.NewRequest("POST", "/api/v1/read", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", userID)

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp readResponse
	err := json.NewDecoder(w.Body).Decode(&resp)
	require.NoError(t, err)
	assert.Equal(t, postID, resp.PostID)
	assert.Equal(t, channelID, resp.ChannelID)
	assert.True(t, resp.ReadAt > 0)
}

func TestHandleRead_Unauthorized(t *testing.T) {
	p, _ := setupTestPlugin(t)

	body, _ := json.Marshal(readRequest{PostID: "post1xabcdefghijklmnopqrst"})
	req := httptest.NewRequest("POST", "/api/v1/read", bytes.NewReader(body))

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestHandleRead_AuthorSelfRead(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := "user1xabcdefghijklmnopqrst"
	postID := "post1xabcdefghijklmnopqrst"
	channelID := "channel1xabcdefghijklmnopq"

	post := &model.Post{
		Id:        postID,
		UserId:    userID,
		ChannelId: channelID,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

	api.On("GetPost", postID).Return(post, nil)
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)
	indexData, _ := json.Marshal([]string{userID})
	api.On("KVGet", idxKey(channelID)).Return(indexData, nil)

	body, _ := json.Marshal(readRequest{PostID: postID})
	req := httptest.NewRequest("POST", "/api/v1/read", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", userID)

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestHandleRead_NonDMChannel(t *testing.T) {
	p, api := setupTestPlugin(t)
	p.configuration.EnabledChannelTypes = "D"

	userID := "user1xabcdefghijklmnopqrst"
	postID := "post1xabcdefghijklmnopqrst"
	channelID := "channel1xabcdefghijklmnopq"

	post := &model.Post{
		Id:        postID,
		UserId:    "user2xabcdefghijklmnopqrst",
		ChannelId: channelID,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeOpen,
	}

	api.On("GetPost", postID).Return(post, nil)
	api.On("GetChannel", channelID).Return(channel, nil)

	body, _ := json.Marshal(readRequest{PostID: postID})
	req := httptest.NewRequest("POST", "/api/v1/read", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", userID)

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestHandleRead_NotMember(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := "user1xabcdefghijklmnopqrst"
	postID := "post1xabcdefghijklmnopqrst"
	channelID := "channel1xabcdefghijklmnopq"

	post := &model.Post{
		Id:        postID,
		UserId:    "user2xabcdefghijklmnopqrst",
		ChannelId: channelID,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

	api.On("GetPost", postID).Return(post, nil)
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(false)

	body, _ := json.Marshal(readRequest{PostID: postID})
	req := httptest.NewRequest("POST", "/api/v1/read", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", userID)

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestHandleRead_RepeatReturnsStoredReadAt(t *testing.T) {
	p, api := setupTestPlugin(t)

	userID := "user1xabcdefghijklmnopqrst"
	postID := "post1xabcdefghijklmnopqrst"
	channelID := "channel1xabcdefghijklmnopq"
	storedReadAt := int64(123456789)

	post := &model.Post{
		Id:        postID,
		UserId:    "user2xabcdefghijklmnopqrst",
		ChannelId: channelID,
		CreateAt:  1000,
	}
	channel := &model.Channel{
		Id:   channelID,
		Type: model.ChannelTypeDirect,
	}

	// A repeat read: the watermark already covers the post and the per-post
	// receipt already exists (first-write-wins rejected the atomic write).
	wmData, _ := json.Marshal(Watermark{PostID: postID, CreateAt: 1000, ReadAt: storedReadAt})
	rrData, _ := json.Marshal(storedReadAt)

	api.On("GetPost", postID).Return(post, nil)
	api.On("GetChannel", channelID).Return(channel, nil)
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionReadChannel).Return(true)

	indexData, _ := json.Marshal([]string{userID})
	api.On("KVGet", idxKey(channelID)).Return(indexData, nil)
	api.On("KVGet", wmKey(channelID, userID)).Return(wmData, nil)
	api.On("KVSetWithOptions", rrKey(channelID, postID, userID), mock.Anything, mock.Anything).Return(false, nil)
	api.On("KVGet", rrKey(channelID, postID, userID)).Return(rrData, nil)

	body, _ := json.Marshal(readRequest{PostID: postID})
	req := httptest.NewRequest("POST", "/api/v1/read", bytes.NewReader(body))
	req.Header.Set("Mattermost-User-Id", userID)

	w := httptest.NewRecorder()
	p.ServeHTTP(&plugin.Context{}, w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp readResponse
	err := json.NewDecoder(w.Body).Decode(&resp)
	require.NoError(t, err)
	assert.Equal(t, postID, resp.PostID)
	assert.Equal(t, storedReadAt, resp.ReadAt, "repeat read must report the stored read time, not a fresh timestamp")

	api.AssertNotCalled(t, "PublishWebSocketEvent", wsEventReceipt, mock.Anything, mock.Anything)
}
