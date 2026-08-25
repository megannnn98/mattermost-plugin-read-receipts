package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

func (p *Plugin) registerRoutes() {
	p.router.HandleFunc("POST /api/v1/read", p.handleRead)
	p.router.HandleFunc("POST /api/v1/receipts/query", p.handleQuery)
}

func (p *Plugin) ServeHTTP(c *plugin.Context, w http.ResponseWriter, r *http.Request) {
	p.router.ServeHTTP(w, r)
}

type readRequest struct {
	PostID string `json:"post_id"`
}

type readResponse struct {
	PostID    string `json:"post_id"`
	ChannelID string `json:"channel_id"`
	CreateAt  int64  `json:"create_at"`
	ReadAt    int64  `json:"read_at"`
}

func (p *Plugin) handleRead(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req readRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if req.PostID == "" {
		http.Error(w, "post_id required", http.StatusBadRequest)
		return
	}

	post, channel, err := p.validateReadRequest(userID, req.PostID)
	if err != nil {
		if errors.Is(err, ErrPostNotFound) || errors.Is(err, ErrChannelNotFound) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if errors.Is(err, ErrNotDMChannel) || errors.Is(err, ErrNotMember) || errors.Is(err, ErrAuthorSelfRead) {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	receipt, err := p.markAsRead(userID, post, channel)
	if err != nil {
		p.client.Log.Warn("mark as read failed", "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	resp := readResponse{
		PostID:    receipt.PostID,
		ChannelID: receipt.ChannelID,
		CreateAt:  receipt.CreateAt,
		ReadAt:    receipt.ReadAt,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (p *Plugin) markAsRead(readerID string, post *model.Post, channel *model.Channel) (*Receipt, error) {
	config := p.getConfiguration()
	ttlSeconds := config.retentionSeconds()
	now := nowMillis()

	// 1. Persist the per-post receipt FIRST. If this write fails the watermark is
	// untouched, so the endpoint can report an error honestly (the reader has not
	// committed a read yet and a retry will just do the same work again).
	written, err := p.setReceiptAtomic(channel.Id, post.Id, readerID, now, ttlSeconds)
	if err != nil {
		return nil, err
	}

	receipt := &Receipt{
		PostID:    post.Id,
		ChannelID: channel.Id,
		CreateAt:  post.CreateAt,
		ReadAt:    now,
		ReaderID:  readerID,
	}

	if !written {
		// First write wins: a receipt already exists for this reader. Report the
		// stored read time so a repeated request is fully idempotent.
		if stored, err := p.getReceipt(channel.Id, post.Id, readerID); err == nil && stored != nil {
			receipt.ReadAt = *stored
		}
	}

	// 2. Raise the watermark. On failure the state stays conservative (receipt is
	// written, watermark lags) and no WS event is published — a repeated request
	// fixes it.
	advanced, err := p.advanceWatermark(channel.Id, readerID, post, now)
	if err != nil {
		return nil, err
	}

	// 3. Publish the WS event only after BOTH writes succeeded and at least one of
	// them changed something, so a repeated POST does not emit spurious events.
	if written || advanced {
		p.publishReceiptWS(receipt, post.UserId)
	}

	p.debugLog("read", "post", post.Id, "reader", readerID, "channel", channel.Id)

	return receipt, nil
}

func (p *Plugin) publishReceiptWS(receipt *Receipt, authorID string) {
	p.API.PublishWebSocketEvent(wsEventReceipt, map[string]interface{}{
		"post_id":    receipt.PostID,
		"channel_id": receipt.ChannelID,
		"create_at":  receipt.CreateAt,
		"read_at":    receipt.ReadAt,
		"reader_id":  receipt.ReaderID,
		"author_id":  authorID,
	}, &model.WebsocketBroadcast{
		UserId: authorID,
	})
}

type queryRequest struct {
	ChannelID string   `json:"channel_id"`
	PostIDs   []string `json:"post_ids"`
}

type watermarkResponse struct {
	PostID   string `json:"post_id,omitempty"`
	CreateAt int64  `json:"create_at,omitempty"`
	ReadAt   int64  `json:"read_at,omitempty"`
}

type queryResponse struct {
	Watermark *watermarkResponse `json:"watermark"`
	Receipts  map[string]int64   `json:"receipts"`
	Debug     bool               `json:"debug"`
}

func (p *Plugin) handleQuery(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req queryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if req.ChannelID == "" {
		http.Error(w, "channel_id required", http.StatusBadRequest)
		return
	}

	channel, err := p.validateQueryRequest(userID, req.ChannelID)
	if err != nil {
		if errors.Is(err, ErrChannelNotFound) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if errors.Is(err, ErrNotDMChannel) || errors.Is(err, ErrNotMember) {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	otherUserID, err := p.getOtherDMMember(channel, userID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	postIDs := req.PostIDs
	if len(postIDs) > maxQueryIDs {
		postIDs = postIDs[:maxQueryIDs]
	}

	wm, err := p.getWatermark(channel.Id, otherUserID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	receipts := make(map[string]int64)
	for _, postID := range postIDs {
		readAt, err := p.getReceipt(channel.Id, postID, otherUserID)
		if err != nil {
			continue
		}
		if readAt != nil {
			receipts[postID] = *readAt
		}
	}

	var wmResp *watermarkResponse
	if wm != nil {
		wmResp = &watermarkResponse{
			PostID:   wm.PostID,
			CreateAt: wm.CreateAt,
			ReadAt:   wm.ReadAt,
		}
	}

	config := p.getConfiguration()
	resp := queryResponse{
		Watermark: wmResp,
		Receipts:  receipts,
		Debug:     config.EnableDebugLogging,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (p *Plugin) getConfiguration() *configuration {
	p.configMu.RLock()
	defer p.configMu.RUnlock()
	if p.configuration == nil {
		return &configuration{}
	}
	return p.configuration
}

func (p *Plugin) debugLog(msg string, kvPairs ...interface{}) {
	config := p.getConfiguration()
	if config.EnableDebugLogging {
		args := append([]interface{}{"msg", msg}, kvPairs...)
		p.client.Log.Debug("read-receipts", args...)
	}
}
