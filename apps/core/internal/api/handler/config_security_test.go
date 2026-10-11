package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"caorushizi.cn/mediago/internal/api/sse"
	"caorushizi.cn/mediago/internal/app"
	"caorushizi.cn/mediago/pkg/conf"
	"github.com/gin-gonic/gin"
)

// mapConfigStore is a minimal ConfigStore backed by an in-memory map.
type mapConfigStore struct {
	values map[string]any
}

func (s *mapConfigStore) Get(key string) any { return s.values[key] }
func (s *mapConfigStore) Set(key string, value any) error {
	s.values[key] = value
	return nil
}
func (s *mapConfigStore) Update(partial map[string]any) error {
	for key, value := range partial {
		s.values[key] = value
	}
	return nil
}
func (s *mapConfigStore) Store() any { return s.values }

func decodeSuccessData(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("failed to decode response: %v (body=%s)", err, body)
	}
	return payload.Data
}

func TestGetStoreRedactsPasswordHashKeepsCredentials(t *testing.T) {
	gin.SetMode(gin.TestMode)

	store := &mapConfigStore{values: map[string]any{
		"passwordHash": "stored-password-hash",
		"apiKey":       "stored-api-key",
		"mcpToken":     "stored-mcp-token",
		"language":     "zh",
	}}
	configHandler := NewConfigHandler(store, sse.New())
	engine := gin.New()
	engine.GET("/config", configHandler.GetStore)

	request := httptest.NewRequest(http.MethodGet, "/config", nil)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", recorder.Code)
	}

	data := decodeSuccessData(t, recorder.Body.Bytes())
	if got := data["passwordHash"]; got != "" {
		t.Fatalf("passwordHash leaked in GET store: %v", got)
	}
	if got := data["apiKey"]; got != "stored-api-key" {
		t.Fatalf("apiKey must be preserved, got: %v", got)
	}
	if got := data["mcpToken"]; got != "stored-mcp-token" {
		t.Fatalf("mcpToken must be preserved, got: %v", got)
	}
	if got := data["language"]; got != "zh" {
		t.Fatalf("unrelated key changed, got: %v", got)
	}
}

func TestGetKeyPasswordHashReturnsNotFound(t *testing.T) {
	gin.SetMode(gin.TestMode)

	store := &mapConfigStore{values: map[string]any{
		"passwordHash": "stored-password-hash",
		"language":     "zh",
	}}
	configHandler := NewConfigHandler(store, sse.New())
	engine := gin.New()
	engine.GET("/config/:key", configHandler.GetKey)

	sensitiveRequest := httptest.NewRequest(http.MethodGet, "/config/passwordHash", nil)
	sensitiveRecorder := httptest.NewRecorder()
	engine.ServeHTTP(sensitiveRecorder, sensitiveRequest)
	if sensitiveRecorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for passwordHash, got: %d (body=%s)", sensitiveRecorder.Code, sensitiveRecorder.Body.String())
	}
	if strings.Contains(sensitiveRecorder.Body.String(), "stored-password-hash") {
		t.Fatal("404 response leaked the password hash value")
	}

	normalRequest := httptest.NewRequest(http.MethodGet, "/config/language", nil)
	normalRecorder := httptest.NewRecorder()
	engine.ServeHTTP(normalRecorder, normalRequest)
	if normalRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 for non-sensitive key, got: %d", normalRecorder.Code)
	}
}

func collectBroadcasts(hub *sse.Hub, channel chan sse.Event, count int) map[string]any {
	values := make(map[string]any, count)
	for i := 0; i < count; i++ {
		event := <-channel
		payload, ok := event.Data.(map[string]any)
		if !ok {
			continue
		}
		key, _ := payload["key"].(string)
		values[key] = payload["value"]
	}
	return values
}

func TestUpdateBroadcastRedactsPasswordHash(t *testing.T) {
	gin.SetMode(gin.TestMode)

	hub := sse.New()
	channel := hub.Subscribe()
	store := &mapConfigStore{values: map[string]any{}}
	configHandler := NewConfigHandler(store, hub)
	engine := gin.New()
	engine.POST("/config", configHandler.Update)

	body := strings.NewReader(`{"passwordHash":"new-hash","apiKey":"new-api-key"}`)
	request := httptest.NewRequest(http.MethodPost, "/config", body)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", recorder.Code)
	}

	values := collectBroadcasts(hub, channel, 2)
	if got, ok := values["passwordHash"]; !ok || got != "" {
		t.Fatalf("passwordHash broadcast not redacted: %v", got)
	}
	if got := values["apiKey"]; got != "new-api-key" {
		t.Fatalf("apiKey broadcast must be preserved, got: %v", got)
	}
}

func TestSetKeyBroadcastRedactsPasswordHash(t *testing.T) {
	gin.SetMode(gin.TestMode)

	hub := sse.New()
	channel := hub.Subscribe()
	store := &mapConfigStore{values: map[string]any{}}
	configHandler := NewConfigHandler(store, hub)
	engine := gin.New()
	engine.PUT("/config/:key", configHandler.SetKey)

	body := strings.NewReader(`{"value":"new-hash"}`)
	request := httptest.NewRequest(http.MethodPut, "/config/passwordHash", body)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", recorder.Code)
	}

	values := collectBroadcasts(hub, channel, 1)
	if got, ok := values["passwordHash"]; !ok || got != "" {
		t.Fatalf("passwordHash broadcast not redacted: %v", got)
	}
}

func TestDefaultConfigHostIsLoopback(t *testing.T) {
	if got := app.DefaultConfig().Host; got != "127.0.0.1" {
		t.Fatalf("DefaultConfig().Host = %q, want %q", got, "127.0.0.1")
	}
}

// TestGetStoreRedactsViaRealConfStore exercises the real conf[AppStore] path
// (not the in-memory map stub) to prove redaction survives JSON round-tripping.
func TestGetStoreRedactsViaRealConfStore(t *testing.T) {
	gin.SetMode(gin.TestMode)

	realStore, err := conf.New(conf.Options[app.AppStore]{
		ConfigName: "config",
		CWD:        t.TempDir(),
		Defaults:   app.DefaultAppStore(),
	})
	if err != nil {
		t.Fatalf("conf.New: %v", err)
	}
	for key, value := range map[string]any{
		"passwordHash": "real-password-hash",
		"apiKey":       "real-api-key",
		"mcpToken":     "real-mcp-token",
	} {
		if err := realStore.Set(key, value); err != nil {
			t.Fatalf("set %s: %v", key, err)
		}
	}

	configHandler := NewConfigHandler(WrapConfStore[app.AppStore](realStore), sse.New())
	engine := gin.New()
	engine.GET("/config", configHandler.GetStore)

	request := httptest.NewRequest(http.MethodGet, "/config", nil)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d (body=%s)", recorder.Code, recorder.Body.String())
	}
	data := decodeSuccessData(t, recorder.Body.Bytes())
	if got := data["passwordHash"]; got != "" {
		t.Fatalf("passwordHash leaked via real conf store: %v", got)
	}
	if got := data["apiKey"]; got != "real-api-key" {
		t.Fatalf("apiKey must be preserved, got: %v", got)
	}
	if got := data["mcpToken"]; got != "real-mcp-token" {
		t.Fatalf("mcpToken must be preserved, got: %v", got)
	}
}

// TestSetKeyBroadcastPreservesApiKey is the reverse assertion of
// TestSetKeyBroadcastRedactsPasswordHash: rotating apiKey must still reach
// subscribers with its real value.
func TestSetKeyBroadcastPreservesApiKey(t *testing.T) {
	gin.SetMode(gin.TestMode)

	hub := sse.New()
	channel := hub.Subscribe()
	store := &mapConfigStore{values: map[string]any{}}
	configHandler := NewConfigHandler(store, hub)
	engine := gin.New()
	engine.PUT("/config/:key", configHandler.SetKey)

	body := strings.NewReader(`{"value":"rotated-api-key"}`)
	request := httptest.NewRequest(http.MethodPut, "/config/apiKey", body)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", recorder.Code)
	}

	values := collectBroadcasts(hub, channel, 1)
	if got := values["apiKey"]; got != "rotated-api-key" {
		t.Fatalf("apiKey broadcast must be preserved, got: %v", got)
	}
}

// TestGetKeyDotPathSensitiveReturnsNotFound ensures the GetKey guard is aligned
// with dot-path lookup semantics: any dotted key whose segments include a
// sensitive field is treated as sensitive (fail-closed).
func TestGetKeyDotPathSensitiveReturnsNotFound(t *testing.T) {
	gin.SetMode(gin.TestMode)

	store := &mapConfigStore{values: map[string]any{
		"passwordHash": "stored-password-hash",
		"language":     "zh",
	}}
	configHandler := NewConfigHandler(store, sse.New())
	engine := gin.New()
	engine.GET("/config/:key", configHandler.GetKey)

	for _, key := range []string{"passwordHash", "x.passwordHash", "passwordHash.y"} {
		request := httptest.NewRequest(http.MethodGet, "/config/"+key, nil)
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("expected 404 for key %q, got: %d (body=%s)", key, recorder.Code, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), "stored-password-hash") {
			t.Fatalf("response for key %q leaked the password hash", key)
		}
	}
}
