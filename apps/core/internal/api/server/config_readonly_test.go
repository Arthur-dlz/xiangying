package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"caorushizi.cn/mediago/internal/core"
	"github.com/gin-gonic/gin"
)

// writeConfigStore is a ConfigStore whose apiKey is configurable, used to
// exercise the CRG-FIX-10-F3 read-only degradation on config writes.
type writeConfigStore struct {
	apiKey string
}

func (s *writeConfigStore) Get(key string) any {
	if key == "apiKey" {
		return s.apiKey
	}
	return nil
}
func (s *writeConfigStore) Set(string, any) error       { return nil }
func (s *writeConfigStore) Update(map[string]any) error { return nil }
func (s *writeConfigStore) Store() any                  { return map[string]any{"language": "en"} }

func newConfigWriteServer(t *testing.T, store *writeConfigStore, opts Options) *Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	server := New(core.NewTaskQueue(nil, 1), nil, nil, store, opts)
	t.Cleanup(server.Close)
	return server
}

func postConfig(t *testing.T, server *Server, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	body := strings.NewReader(`{"language":"en"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/config", body)
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	server.Engine().ServeHTTP(recorder, request)
	return recorder
}

// TestConfigWriteReadOnlyOnExposedServerWithoutAuth covers the core F3 gap: a
// non-desktop server bound off-loopback with no authentication must reject
// config mutations (read-only degradation).
func TestConfigWriteReadOnlyOnExposedServerWithoutAuth(t *testing.T) {
	server := newConfigWriteServer(t, &writeConfigStore{}, Options{
		EnableAuth: false,
		Host:       "0.0.0.0",
	})

	response := postConfig(t, server, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("exposed no-auth config write status = %d, want %d; body=%s",
			response.Code, http.StatusForbidden, response.Body.String())
	}
}

// TestConfigWriteAllowedOnLoopback ensures the read-only degradation does not
// regress a local (loopback) deployment running without authentication.
func TestConfigWriteAllowedOnLoopback(t *testing.T) {
	server := newConfigWriteServer(t, &writeConfigStore{}, Options{
		EnableAuth: false,
		Host:       "127.0.0.1",
	})

	response := postConfig(t, server, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("loopback config write status = %d, want %d; body=%s",
			response.Code, http.StatusOK, response.Body.String())
	}
}

// TestConfigWriteAllowedWhenAuthEnabledAndConfigured ensures an authenticated
// request on an exposed server may still mutate configuration.
func TestConfigWriteAllowedWhenAuthEnabledAndConfigured(t *testing.T) {
	server := newConfigWriteServer(t, &writeConfigStore{apiKey: "secret"}, Options{
		EnableAuth: true,
		Host:       "0.0.0.0",
	})

	response := postConfig(t, server, map[string]string{"X-API-Key": "secret"})
	if response.Code != http.StatusOK {
		t.Fatalf("authenticated config write status = %d, want %d; body=%s",
			response.Code, http.StatusOK, response.Body.String())
	}
}

// TestConfigWriteReadOnlyBeforeAuthSetup covers the setup-window gap: with auth
// enabled but no apiKey yet configured, an exposed server must not accept
// anonymous config writes.
func TestConfigWriteReadOnlyBeforeAuthSetup(t *testing.T) {
	server := newConfigWriteServer(t, &writeConfigStore{}, Options{
		EnableAuth: true,
		Host:       "0.0.0.0",
	})

	response := postConfig(t, server, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("pre-setup exposed config write status = %d, want %d; body=%s",
			response.Code, http.StatusForbidden, response.Body.String())
	}
}

// TestConfigWriteAllowedInDesktopMode ensures desktop mode (Electron token)
// is never blocked by the read-only guard.
func TestConfigWriteAllowedInDesktopMode(t *testing.T) {
	server := newConfigWriteServer(t, &writeConfigStore{}, Options{
		EnableAuth:       true,
		ElectronAPIToken: "desktop-secret",
		Host:             "0.0.0.0",
	})

	response := postConfig(t, server, map[string]string{"Authorization": "Bearer desktop-secret"})
	if response.Code != http.StatusOK {
		t.Fatalf("desktop config write status = %d, want %d; body=%s",
			response.Code, http.StatusOK, response.Body.String())
	}
}
