package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

func (p *Plugin) registerRoutes() {
	p.router.HandleFunc("POST /api/v1/read", p.handleRead)
	p.router.HandleFunc("POST /api/v1/receipts/query", p.handleQuery)
	p.router.HandleFunc("POST /api/v1/receipts/post", p.handlePostReaders)
	p.router.HandleFunc("GET /api/v1/config", p.handleConfig)
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
	indexedNow, err := p.ensureReaderIndexed(channel.Id, readerID)
	if err != nil {
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
	// A v0.1 reader can have a watermark without an idx_ entry. Indexing them
	// immediately makes every post below that watermark count as read, including
	// if a later receipt write fails. Refresh channel aggregates once, now.
	invalidatedByLegacyWatermark := indexedNow && wm != nil
	if invalidatedByLegacyWatermark {
		p.publishReceiptsChangedWS(channel.Id)
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
	if advanced && !invalidatedByLegacyWatermark {
		p.publishReceiptsChangedWS(channel.Id)
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

// publishReceiptsChangedWS tells channel members only that their locally cached
// aggregate statuses may be stale. In particular it must never carry reader_id,
// post_id or a watermark: those would turn a refresh signal into a read-activity
// side channel for someone else's posts.
func (p *Plugin) publishReceiptsChangedWS(channelID string) {
	p.API.PublishWebSocketEvent(wsEventReceiptsChanged, map[string]interface{}{
		"channel_id": channelID,
	}, &model.WebsocketBroadcast{
		ChannelId: channelID,
	})
}

type queryRequest struct {
	ChannelID string   `json:"channel_id"`
	PostIDs   []string `json:"post_ids"`
}

// postStatus is everything the sender is allowed to learn about one of their own
// posts: how many people read it, whether that number is a lower bound, and —
// only when the channel has a single reader — the exact time.
//
// Deliberately NOT per-reader watermarks. Those are channel-wide read positions:
// handing them to every member would let anyone reconstruct who read whose
// message and when, which is fine for a two-person DM and is not fine for a
// group, a private channel or an open one.
type postStatus struct {
	Count     int   `json:"count"`
	Truncated bool  `json:"truncated"`
	ReadAt    int64 `json:"read_at,omitempty"`
}

type queryResponse struct {
	Posts     map[string]postStatus `json:"posts"`
	Truncated bool                  `json:"truncated"`
}

// maxPostPages bounds the fan-out of authorship validation. The plugin API has no
// batch "get these post ids", so the alternative would be one GetPost per
// requested id — up to 200 round trips per channel open. Paging the channel
// instead answers the same question in at most maxPostPages calls; a requested
// post older than that simply gets no status, which degrades the display and
// never leaks anything.
const maxPostPages = 3

// resolveOwnPosts returns create_at for those requested ids that really are the
// requester's own, live posts in this channel. Everything else — someone else's
// post, a post from another channel, a deleted one, a fabricated id — is dropped
// here, which is what keeps the endpoint from answering questions about posts the
// caller does not own.
func (p *Plugin) resolveOwnPosts(channel *model.Channel, userID string, postIDs []string) (map[string]int64, error) {
	pending := make(map[string]struct{}, len(postIDs))
	for _, postID := range postIDs {
		if model.IsValidId(postID) {
			pending[postID] = struct{}{}
		}
	}
	own := make(map[string]int64, len(pending))
	if len(pending) == 0 {
		return own, nil
	}

	for page := 0; page < maxPostPages && len(pending) > 0; page++ {
		list, appErr := p.API.GetPostsForChannel(channel.Id, page, maxQueryIDs)
		if appErr != nil {
			return nil, fmt.Errorf("get posts for channel: %s", appErr.Error())
		}
		if list == nil || len(list.Posts) == 0 {
			break
		}
		for postID, post := range list.Posts {
			if _, requested := pending[postID]; !requested {
				continue
			}
			delete(pending, postID)
			if post == nil || post.UserId != userID || post.ChannelId != channel.Id || post.DeleteAt != 0 {
				continue
			}
			own[postID] = post.CreateAt
		}
		if len(list.Posts) < maxQueryIDs {
			break
		}
	}

	return own, nil
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

	postIDs := req.PostIDs
	if len(postIDs) > maxQueryIDs {
		postIDs = postIDs[:maxQueryIDs]
	}

	own, err := p.resolveOwnPosts(channel, userID, postIDs)
	if err != nil {
		p.logWarn("resolve own posts failed", "channel_id", channel.Id, "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	response := queryResponse{Posts: make(map[string]postStatus, len(own))}
	if len(own) == 0 {
		p.writeJSON(w, response)
		return
	}

	readers, err := p.channelReaders(channel.Id, userID, 0)
	if err != nil {
		p.logWarn("reader index read failed", "channel_id", channel.Id, "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	response.Truncated = readers.truncated

	// One watermark per reader, never per post: the count of a post is simply how
	// many readers have read past it, because the watermark is monotonic.
	covers := make([]int64, 0, len(readers.ids))
	for _, readerID := range readers.ids {
		wm, err := p.getWatermark(channel.Id, readerID)
		if err != nil {
			p.logWarn("watermark read failed", "channel_id", channel.Id, "reader_id", readerID, "error", err.Error())
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if wm != nil {
			covers = append(covers, wm.CreateAt)
		}
	}

	for postID, createAt := range own {
		status := postStatus{Truncated: readers.truncated}
		for _, covered := range covers {
			if createAt <= covered {
				status.Count++
			}
		}
		// The exact time costs one read per post per reader, so it is served only
		// for a single-reader channel — in practice a DM, which is where v0.1.0
		// promised it. Authorship is already enforced above, so this is a cost
		// rule, not a security one.
		if status.Count == 1 && len(readers.ids) == 1 {
			readAt, err := p.getReceipt(channel.Id, postID, readers.ids[0])
			if err != nil {
				p.logWarn("receipt read failed", "channel_id", channel.Id, "post_id", postID, "error", err.Error())
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			if readAt != nil {
				status.ReadAt = *readAt
			}
		}
		response.Posts[postID] = status
	}

	p.writeJSON(w, response)
}

type configResponse struct {
	EnabledChannelTypes string `json:"enabled_channel_types"`
}

// handleConfig lets the webapp gate itself on the same setting the server
// enforces. Without it the client would have to discover a disabled channel type
// by being refused, i.e. after it had already rendered an indicator and reported
// a read.
func (p *Plugin) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Mattermost-User-Id") == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	p.writeJSON(w, configResponse{EnabledChannelTypes: p.getConfiguration().enabledChannelTypes()})
}

type postReadersRequest struct {
	PostID string `json:"post_id"`
	Offset int    `json:"offset"`
}

type readerResponse struct {
	UserID string `json:"user_id"`
	ReadAt int64  `json:"read_at"`
	Exact  bool   `json:"exact"`
}

type postReadersResponse struct {
	Readers []readerResponse `json:"readers"`
	// Truncated says the channel has more readers than this page covers, so the
	// list is a prefix and the caller must not present it as complete.
	Truncated  bool `json:"truncated"`
	NextOffset int  `json:"next_offset,omitempty"`
}

func (p *Plugin) handlePostReaders(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req postReadersRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !model.IsValidId(req.PostID) || req.Offset < 0 {
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
	// Who read a message is the author's information. A channel member asking
	// about someone else's post gets nothing, in every channel type.
	if post.UserId != userID {
		http.Error(w, "only the post author can query readers", http.StatusForbidden)
		return
	}
	if post.DeleteAt != 0 {
		http.Error(w, "post not found", http.StatusNotFound)
		return
	}

	readers, err := p.channelReaders(channel.Id, userID, req.Offset)
	if err != nil {
		p.logWarn("reader index read failed", "channel_id", channel.Id, "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	response := postReadersResponse{
		Readers:    make([]readerResponse, 0, len(readers.ids)),
		Truncated:  readers.truncated,
		NextOffset: readers.nextOffset,
	}
	for _, readerID := range readers.ids {
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
