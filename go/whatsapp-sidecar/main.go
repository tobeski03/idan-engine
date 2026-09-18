package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

type request struct {
	ID   string         `json:"id"`
	Op   string         `json:"op"`
	Args map[string]any `json:"args"`
}
type response struct {
	ID     string `json:"id,omitempty"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
type messageEvent struct {
	ID        string    `json:"id"`
	From      string    `json:"from"`
	Sender    string    `json:"sender"`
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp"`
	Internal  bool      `json:"internal"`
	QuotedID  string    `json:"quotedId,omitempty"`
	QuotedSender string `json:"quotedSender,omitempty"`
	QuotedText string   `json:"quotedText,omitempty"`
}

type bridge struct {
	mu            sync.Mutex
	client        *whatsmeow.Client
	store         *sqlstore.Container
	status        string
	registered    bool
	lastQR        string
	starting      bool
	stopRequested bool
	w             io.Writer
	wmu           sync.Mutex
	sentIDs       map[string]struct{}
}

func newBridge(w io.Writer) *bridge {
	return &bridge{status: "stopped", w: w, sentIDs: make(map[string]struct{})}
}

func (b *bridge) emit(v any) {
	b.wmu.Lock()
	defer b.wmu.Unlock()
	_ = json.NewEncoder(b.w).Encode(v)
}
func (b *bridge) statusInfo() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	user := ""
	if b.client != nil && b.client.Store.ID != nil {
		user = b.client.Store.ID.String()
	}
	return map[string]any{"status": b.status, "connected": b.status == "connected", "registered": b.registered, "user": user, "qrAvailable": b.lastQR != ""}
}
func (b *bridge) setStatus(status string, details map[string]any) {
	b.mu.Lock()
	b.status = status
	b.mu.Unlock()
	payload := map[string]any{"event": "status", "status": status}
	for k, v := range details {
		payload[k] = v
	}
	b.emit(payload)
}

func (b *bridge) initialize(dbPath string) error {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?_foreign_keys=on")
	if err != nil {
		return err
	}
	b.store = sqlstore.NewWithDB(db, "sqlite3", waLog.Noop)
	if err = b.store.Upgrade(context.Background()); err != nil {
		return fmt.Errorf("database upgrade: %w", err)
	}
	device, err := b.store.GetFirstDevice(context.Background())
	if err != nil {
		return err
	}
	b.client = whatsmeow.NewClient(device, waLog.Noop)
	b.registered = device.ID != nil
	b.client.AddEventHandler(b.handleEvent)
	return nil
}

func (b *bridge) handleEvent(raw any) {
	switch evt := raw.(type) {
	case *events.Connected:
		b.mu.Lock()
		b.status = "connected"
		b.registered = true
		b.lastQR = ""
		b.mu.Unlock()
		b.setStatus("connected", nil)
	case *events.PairSuccess:
		b.mu.Lock()
		b.registered = true
		b.mu.Unlock()
		b.emit(map[string]any{"event": "paired", "user": evt.ID.String()})
	case *events.LoggedOut:
		b.mu.Lock()
		b.status = "logged_out"
		b.registered = false
		b.lastQR = ""
		b.mu.Unlock()
		b.setStatus("logged_out", nil)
	case *events.StreamReplaced:
		b.setStatus("stream_replaced", nil)
	case *events.Message:
		ownChat := false
		if b.client != nil {
			if b.client.Store.ID != nil {
				ownChat = evt.Info.Chat.User == b.client.Store.ID.User && evt.Info.Chat.Server == b.client.Store.ID.Server
			}
			if !ownChat && !b.client.Store.LID.IsEmpty() {
				ownChat = evt.Info.Chat.User == b.client.Store.LID.User && evt.Info.Chat.Server == b.client.Store.LID.Server
			}
		}
		if evt.Info.Chat == types.StatusBroadcastJID || (!ownChat && evt.Info.IsFromMe) {
			return
		}
		if evt.Info.IsFromMe {
			b.mu.Lock()
			_, sent := b.sentIDs[string(evt.Info.ID)]
			delete(b.sentIDs, string(evt.Info.ID))
			b.mu.Unlock()
			if sent {
				return
			}
		}
		quotedID, quotedSender, quotedText := extractQuote(evt.Message)
		b.emit(map[string]any{"event": "message", "message": messageEvent{ID: string(evt.Info.ID), From: evt.Info.Chat.String(), Sender: evt.Info.PushName, Text: extractText(evt.Message), Timestamp: evt.Info.Timestamp, Internal: ownChat, QuotedID: quotedID, QuotedSender: quotedSender, QuotedText: quotedText}})
	}
}

func extractQuote(msg *waE2E.Message) (string, string, string) {
	if msg == nil || msg.GetExtendedTextMessage() == nil || msg.GetExtendedTextMessage().GetContextInfo() == nil {
		return "", "", ""
	}
	info := msg.GetExtendedTextMessage().GetContextInfo()
	quoted := info.GetQuotedMessage()
	if quoted == nil {
		return string(info.GetStanzaID()), info.GetParticipant(), ""
	}
	return string(info.GetStanzaID()), info.GetParticipant(), extractText(quoted)
}

func extractText(msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}
	if text := msg.GetConversation(); text != "" {
		return text
	}
	if text := msg.GetExtendedTextMessage().GetText(); text != "" {
		return text
	}
	if text := msg.GetImageMessage().GetCaption(); text != "" {
		return text
	}
	if text := msg.GetVideoMessage().GetCaption(); text != "" {
		return text
	}
	if text := msg.GetDocumentMessage().GetCaption(); text != "" {
		return text
	}
	return ""
}

func (b *bridge) qrDataURL(raw string) string {
	data, err := qrcode.Encode(raw, qrcode.Medium, 280)
	if err != nil {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
}

func (b *bridge) start() error {
	b.mu.Lock()
	if b.client == nil {
		b.mu.Unlock()
		return errors.New("WhatsApp bridge is not initialized")
	}
	if b.client.IsConnected() {
		b.status = "connected"
		b.mu.Unlock()
		return nil
	}
	if b.starting {
		b.mu.Unlock()
		return nil
	}
	b.starting = true
	b.stopRequested = false
	registered := b.registered
	b.mu.Unlock()
	if !registered {
		qr, err := b.client.GetQRChannel(context.Background())
		if err != nil {
			b.mu.Lock()
			b.starting = false
			b.mu.Unlock()
			return err
		}
		go func() {
			for item := range qr {
				if item.Event == whatsmeow.QRChannelEventCode {
					b.mu.Lock()
					b.lastQR = item.Code
					b.mu.Unlock()
					b.emit(map[string]any{"event": "qr", "qr": b.qrDataURL(item.Code)})
				} else if item.Event == "error" {
					b.emit(map[string]any{"event": "error", "error": item.Error.Error()})
				}
			}
		}()
	}
	b.setStatus("connecting", nil)
	err := b.client.Connect()
	b.mu.Lock()
	b.starting = false
	b.mu.Unlock()
	if err != nil {
		b.setStatus("error", map[string]any{"error": err.Error()})
		return err
	}
	return nil
}
func (b *bridge) stop() {
	b.mu.Lock()
	b.stopRequested = true
	c := b.client
	b.status = "stopped"
	b.mu.Unlock()
	if c != nil {
		c.Disconnect()
	}
	b.emit(map[string]any{"event": "status", "status": "stopped"})
}

func argString(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}
func (b *bridge) handle(req request) response {
	switch req.Op {
	case "status":
		return response{ID: req.ID, OK: true, Result: b.statusInfo()}
	case "start":
		if err := b.start(); err != nil {
			return response{ID: req.ID, Error: err.Error()}
		}
		return response{ID: req.ID, OK: true, Result: b.statusInfo()}
	case "stop":
		b.stop()
		return response{ID: req.ID, OK: true, Result: b.statusInfo()}
	case "qr":
		if err := b.start(); err != nil {
			return response{ID: req.ID, Error: err.Error()}
		}
		deadline := time.NewTimer(30 * time.Second)
		defer deadline.Stop()
		for {
			b.mu.Lock()
			raw := b.lastQR
			status := b.status
			b.mu.Unlock()
			if raw != "" {
				return response{ID: req.ID, OK: true, Result: map[string]any{"qr": b.qrDataURL(raw)}}
			}
			if status == "connected" || status == "logged_out" {
				return response{ID: req.ID, OK: true, Result: map[string]any{"qr": nil}}
			}
			select {
			case <-deadline.C:
				return response{ID: req.ID, OK: true, Result: map[string]any{"qr": nil}}
			case <-time.After(100 * time.Millisecond):
			}
		}
	case "send":
		to, err := types.ParseJID(argString(req.Args, "to"))
		if err != nil {
			return response{ID: req.ID, Error: err.Error()}
		}
		body := argString(req.Args, "text")
		if body == "" || len(body) > 4096 {
			return response{ID: req.ID, Error: "message must contain 1-4096 characters"}
		}
		if !b.client.IsConnected() {
			return response{ID: req.ID, Error: "WhatsApp is not connected"}
		}
		message := &waE2E.Message{Conversation: proto.String(body)}
		if quotedID := argString(req.Args, "quotedId"); quotedID != "" {
			message = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(body), ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String(quotedID), Participant: proto.String(argString(req.Args, "quotedSender"))}}}
		}
		resp, err := b.client.SendMessage(context.Background(), to, message)
		if err != nil {
			return response{ID: req.ID, Error: err.Error()}
		}
		b.mu.Lock()
		b.sentIDs[string(resp.ID)] = struct{}{}
		b.mu.Unlock()
		return response{ID: req.ID, OK: true, Result: map[string]any{"sent": true, "to": to.String(), "id": string(resp.ID)}}
	case "send_image":
		to, err := types.ParseJID(argString(req.Args, "to"))
		if err != nil {
			return response{ID: req.ID, Error: err.Error()}
		}
		imageURL := argString(req.Args, "url")
		if imageURL == "" {
			return response{ID: req.ID, Error: "image URL is required"}
		}
		parsed, err := http.NewRequest(http.MethodGet, imageURL, nil)
		if err != nil || (parsed.URL.Scheme != "https" && parsed.URL.Scheme != "http") {
			return response{ID: req.ID, Error: "image URL must use http or https"}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		download, err := http.DefaultClient.Do(parsed.WithContext(ctx))
		if err != nil {
			return response{ID: req.ID, Error: "image download failed: " + err.Error()}
		}
		defer download.Body.Close()
		if download.StatusCode < 200 || download.StatusCode >= 300 {
			return response{ID: req.ID, Error: fmt.Sprintf("image download failed (%d)", download.StatusCode)}
		}
		if download.ContentLength > 15*1024*1024 {
			return response{ID: req.ID, Error: "image is larger than 15 MB"}
		}
		data, err := io.ReadAll(io.LimitReader(download.Body, 15*1024*1024+1))
		if err != nil {
			return response{ID: req.ID, Error: "image download failed: " + err.Error()}
		}
		if len(data) > 15*1024*1024 {
			return response{ID: req.ID, Error: "image is larger than 15 MB"}
		}
		mime := download.Header.Get("Content-Type")
		if strings.Contains(mime, ";") {
			mime = strings.SplitN(mime, ";", 2)[0]
		}
		if !strings.HasPrefix(mime, "image/") {
			return response{ID: req.ID, Error: "URL did not return an image"}
		}
		upload, err := b.client.Upload(ctx, data, whatsmeow.MediaImage)
		if err != nil {
			return response{ID: req.ID, Error: "image upload failed: " + err.Error()}
		}
		caption := argString(req.Args, "caption")
		image := &waE2E.ImageMessage{Caption: proto.String(caption), Mimetype: proto.String(mime), URL: &upload.URL, DirectPath: &upload.DirectPath, MediaKey: upload.MediaKey, FileEncSHA256: upload.FileEncSHA256, FileSHA256: upload.FileSHA256, FileLength: &upload.FileLength}
		resp, err := b.client.SendMessage(ctx, to, &waE2E.Message{ImageMessage: image})
		if err != nil {
			return response{ID: req.ID, Error: err.Error()}
		}
		b.mu.Lock()
		b.sentIDs[string(resp.ID)] = struct{}{}
		b.mu.Unlock()
		return response{ID: req.ID, OK: true, Result: map[string]any{"sent": true, "to": to.String(), "id": string(resp.ID), "image": true}}
	default:
		return response{ID: req.ID, Error: "unknown operation: " + req.Op}
	}
}

func main() {
	state := os.Getenv("IDAN_WHATSAPP_STATE_DIR")
	if state == "" {
		state = filepath.Join(os.TempDir(), "idanCLI", "whatsapp-whatsmeow")
	}
	if err := os.MkdirAll(state, 0700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	b := newBridge(os.Stdout)
	if err := b.initialize(filepath.Join(state, "session.db")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			b.emit(response{OK: false, Error: err.Error()})
			continue
		}
		res := b.handle(req)
		if !res.OK && res.Error == "" {
			res.Error = "request failed"
		}
		b.emit(res)
	}
	b.stop()
}
