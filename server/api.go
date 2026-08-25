package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

func (p *Plugin) registerRoutes() {
	p.router.HandleFunc("POST /api/v1/read", p.handleRead)
	p.router.HandleFunc("POST /api/v1/receipts/query", p.handleQuery)
	p.router.HandleFunc("POST /api/v1/receipts/post", p.handlePostReaders)
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
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)

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

	if !model.IsValidId(req.PostID) {
		http.Error(w, "post_id required", http.StatusBadRequest)
		return
	}

	post, channel, err := p.validateReadRequest(userID, req.PostID)
	if err != nil {
		if errors.Is(err, ErrPostNotFound) || errors.Is(err, ErrChannelNotFound) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if errors.Is(err, ErrChannelTypeDisabled) || errors.Is(err, ErrNotMember) || errors.Is(err, ErrAuthorSelfRead) {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	receipt, err := p.markAsRead(userID, post, channel)
	if err != nil {
		p.logWarn("mark as read failed", "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	resp := readResponse{
		PostID:    receipt.PostID,
		ChannelID: receipt.ChannelID,
		CreateAt:  receipt.CreateAt,
		ReadAt:    receipt.ReadAt,
	}

	p.writeJSON(w, resp)
}

func (p *Plugin) markAsRead(readerID string, post *model.Post, channel *model.Channel) (*Receipt, error) {
	if err := p.ensureReaderIndexed(channel.Id, readerID); err != nil {
		return nil, err
	}

	config := p.getConfiguration()
	ttlSeconds := config.retentionSeconds()
	now := p.now()

	// 0. The watermark is the authority on "already read": it covers every post
	// up to its create_at and never expires. A post it covers was read earlier,
	// even when the per-post receipt has since expired by TTL, so it must not be
	// re-stamped with a fresh time and must not be re-announced to the author.
	// Without this a reader who simply scrolls past old messages after a restart
	// would move "Read 14:02" to today's time for a month-old message.
	wm, _, err := p.getWatermarkRaw(channel.Id, readerID)
	if err != nil {
		return nil, err
	}
	if wm != nil && post.CreateAt <= wm.CreateAt {
		// Exact time from the per-post receipt when it is still there, the
		// watermark's read time as the documented approximation otherwise.
		readAt := wm.ReadAt
		if stored, err := p.getReceipt(channel.Id, post.Id, readerID); err == nil && stored != nil {
			readAt = *stored
		}
		return &Receipt{
			PostID:    post.Id,
			ChannelID: channel.Id,
			CreateAt:  post.CreateAt,
			ReadAt:    readAt,
			ReaderID:  readerID,
		}, nil
	}

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
	advanced, err := p.advanceWatermark(channel.Id, readerID, post, receipt.ReadAt)
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
	ReaderID string `json:"reader_id"`
	PostID   string `json:"post_id,omitempty"`
	CreateAt int64  `json:"create_at,omitempty"`
	ReadAt   int64  `json:"read_at,omitempty"`
}

type queryResponse struct {
	Watermarks []watermarkResponse         `json:"watermarks"`
	Receipts   map[string]map[string]int64 `json:"receipts"`
	Truncated  bool                        `json:"truncated"`
}

func (p *Plugin) handleQuery(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)

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
		if errors.Is(err, ErrChannelTypeDisabled) || errors.Is(err, ErrNotMember) {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	readers, _, err := p.getReaderIndex(channel.Id)
	if err != nil {
		p.logWarn("reader index read failed", "channel_id", channel.Id, "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	readers, truncated := boundedReaders(readers, userID)

	postIDs := req.PostIDs
	if len(postIDs) > maxQueryIDs {
		postIDs = postIDs[:maxQueryIDs]
	}

	response := queryResponse{
		Watermarks: make([]watermarkResponse, 0, len(readers)),
		Receipts:   make(map[string]map[string]int64),
		Truncated:  truncated,
	}
	for _, readerID := range readers {
		wm, err := p.getWatermark(channel.Id, readerID)
		if err != nil {
			p.logWarn("watermark read failed", "channel_id", channel.Id, "reader_id", readerID, "error", err.Error())
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if wm != nil {
			response.Watermarks = append(response.Watermarks, watermarkResponse{ReaderID: readerID, PostID: wm.PostID, CreateAt: wm.CreateAt, ReadAt: wm.ReadAt})
		}
	}

	// Exact receipts preserve the v0.1 DM contract, but querying them for every
	// reader in a group would turn one channel open into K*M KV reads.
	if len(readers) == 1 {
		readerID := readers[0]
		for _, postID := range postIDs {
			if !model.IsValidId(postID) {
				continue
			}
			readAt, err := p.getReceipt(channel.Id, postID, readerID)
			if err != nil {
				p.logWarn("receipt read failed", "channel_id", channel.Id, "post_id", postID, "error", err.Error())
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			if readAt != nil {
				response.Receipts[postID] = map[string]int64{readerID: *readAt}
			}
		}
	}

	p.writeJSON(w, response)
}

func boundedReaders(index []string, excludedID string) ([]string, bool) {
	readers := make([]string, 0, min(len(index), maxQueryReaders))
	truncated := false
	for _, readerID := range index {
		if readerID == excludedID {
			continue
		}
		if len(readers) == maxQueryReaders {
			truncated = true
			break
		}
		readers = append(readers, readerID)
	}
	return readers, truncated
}

type postReadersRequest struct {
	PostID string `json:"post_id"`
}

type readerResponse struct {
	UserID string `json:"user_id"`
	ReadAt int64  `json:"read_at"`
	Exact  bool   `json:"exact"`
}

type postReadersResponse struct {
	Readers   []readerResponse `json:"readers"`
	Truncated bool             `json:"truncated"`
}

func (p *Plugin) handlePostReaders(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req postReadersRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !model.IsValidId(req.PostID) {
		http.Error(w, "post_id required", http.StatusBadRequest)
		return
	}
	post, appErr := p.API.GetPost(req.PostID)
	if appErr != nil {
		http.Error(w, ErrPostNotFound.Error(), http.StatusNotFound)
		return
	}
	channel, err := p.validateQueryRequest(userID, post.ChannelId)
	if err != nil {
		if errors.Is(err, ErrChannelNotFound) {
			http.Error(w, err.Error(), http.StatusNotFound)
		} else if errors.Is(err, ErrChannelTypeDisabled) || errors.Is(err, ErrNotMember) {
			http.Error(w, err.Error(), http.StatusForbidden)
		} else {
			http.Error(w, "internal error", http.StatusInternalServerError)
		}
		return
	}
	if post.UserId != userID {
		http.Error(w, "only the post author can query readers", http.StatusForbidden)
		return
	}
	if post.DeleteAt != 0 {
		http.Error(w, "post not found", http.StatusNotFound)
		return
	}
	index, _, err := p.getReaderIndex(channel.Id)
	if err != nil {
		p.logWarn("reader index read failed", "channel_id", channel.Id, "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	readers, truncated := boundedReaders(index, userID)
	response := postReadersResponse{Readers: make([]readerResponse, 0, len(readers)), Truncated: truncated}
	for _, readerID := range readers {
		receipt, err := p.getReceipt(channel.Id, post.Id, readerID)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if receipt != nil {
			response.Readers = append(response.Readers, readerResponse{UserID: readerID, ReadAt: *receipt, Exact: true})
			continue
		}
		wm, err := p.getWatermark(channel.Id, readerID)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if wm != nil && post.CreateAt <= wm.CreateAt {
			response.Readers = append(response.Readers, readerResponse{UserID: readerID, ReadAt: wm.ReadAt, Exact: false})
		}
	}
	sort.Slice(response.Readers, func(i, j int) bool { return response.Readers[i].ReadAt < response.Readers[j].ReadAt })
	p.writeJSON(w, response)
}

// writeJSON encodes resp as the response body. An encoding failure can only
// happen once the status line is already out, so it is logged rather than
// turned into an error response.
func (p *Plugin) writeJSON(w http.ResponseWriter, resp any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		p.logWarn("write response failed", "error", err.Error())
	}
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
		p.logDebug(msg, kvPairs...)
	}
}

// logWarn and logDebug are nil-tolerant: in tests p.client is nil (the API is
// plugged directly into the plugin), so direct p.client.Log calls would panic.
func (p *Plugin) logWarn(msg string, kv ...interface{}) {
	if p.client != nil {
		p.client.Log.Warn(msg, kv...)
	}
}

func (p *Plugin) logDebug(msg string, kv ...interface{}) {
	if p.client != nil {
		p.client.Log.Debug(msg, kv...)
	}
}
