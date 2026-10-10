package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"caorushizi.cn/mediago/internal/core"
)

const bridgeTestServerToken = "6eb65269a8b3c565ee653d0727f33dfa7a49e1846581495bab057a1a84a6e74f"

func TestBridgeUsesDedicatedAuthAndSkipsGenericCORS(t *testing.T) {
	config := &downloadIdentityConfigStore{values: map[string]any{
		"language": "en",
		"apiKey":   "public-api-key",
	}}
	server := New(core.NewTaskQueue(nil, 1), nil, nil, config, Options{
		EnableAuth:          true,
		ElectronBridgeToken: bridgeTestServerToken,
	})

	publicTokenRequest := httptest.NewRequest(http.MethodPost, "/api/bridge/discoveries/missing/start", nil)
	publicTokenRequest.Header.Set("Authorization", "Bearer public-api-key")
	publicTokenResponse := httptest.NewRecorder()
	server.Engine().ServeHTTP(publicTokenResponse, publicTokenRequest)
	if publicTokenResponse.Code != http.StatusUnauthorized {
		t.Fatalf("public API key status = %d, body = %s", publicTokenResponse.Code, publicTokenResponse.Body.String())
	}

	bridgeRequest := httptest.NewRequest(http.MethodPost, "/api/bridge/discoveries/missing/start", nil)
	bridgeRequest.Header.Set("Authorization", "Bearer "+bridgeTestServerToken)
	bridgeResponse := httptest.NewRecorder()
	server.Engine().ServeHTTP(bridgeResponse, bridgeRequest)
	if bridgeResponse.Code != http.StatusNotFound {
		t.Fatalf("bridge token status = %d, body = %s", bridgeResponse.Code, bridgeResponse.Body.String())
	}

	originRequest := httptest.NewRequest(http.MethodPost, "/api/bridge/discoveries/missing/start", nil)
	originRequest.Header.Set("Authorization", "Bearer "+bridgeTestServerToken)
	originRequest.Header.Set("Origin", "https://attacker.example")
	originResponse := httptest.NewRecorder()
	server.Engine().ServeHTTP(originResponse, originRequest)
	if originResponse.Code != http.StatusForbidden {
		t.Fatalf("origin status = %d, body = %s", originResponse.Code, originResponse.Body.String())
	}
	if got := originResponse.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("bridge received generic CORS header %q", got)
	}
}
