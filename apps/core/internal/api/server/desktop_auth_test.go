package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"caorushizi.cn/mediago/internal/api/handler"
	"caorushizi.cn/mediago/internal/core"
)

type desktopAuthConfigStore struct{}

func (desktopAuthConfigStore) Get(key string) any {
	if key == "apiKey" {
		return "persisted-key"
	}
	return "en"
}
func (desktopAuthConfigStore) Set(string, any) error       { return nil }
func (desktopAuthConfigStore) Update(map[string]any) error { return nil }
func (desktopAuthConfigStore) Store() any                  { return map[string]any{"language": "en"} }

var _ handler.ConfigStore = desktopAuthConfigStore{}

func TestDesktopAPITokenProtectsServerRoutesIndependentOfCORS(t *testing.T) {
	server := New(core.NewTaskQueue(nil, 1), nil, nil, desktopAuthConfigStore{}, Options{
		EnableAuth:       true,
		ElectronAPIToken: "desktop-secret",
	})
	defer server.Close()

	request := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	request.Header.Set("Origin", "https://remote.example")
	response := httptest.NewRecorder()
	server.Engine().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing credential status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("test did not exercise permissive CORS: headers=%v", response.Header())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/config", nil)
	request.Header.Set("Authorization", "Bearer desktop-secret")
	response = httptest.NewRecorder()
	server.Engine().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid credential status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
}
