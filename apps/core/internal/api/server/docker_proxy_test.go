package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"caorushizi.cn/mediago/internal/core"
)

func TestServerRegistersDockerProxyRoutes(t *testing.T) {
	payload := []byte(`{"tasks":[{"url":"https://example.com/play","headers":"Cookie: secret"}],"startDownload":true}`)
	var remoteBody []byte
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/downloads" || r.Header.Get("X-API-Key") != "remote-key" {
			t.Fatalf("unexpected remote request: %s, key=%q", r.URL.Path, r.Header.Get("X-API-Key"))
		}
		remoteBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"code":200,"data":[]}`))
	}))
	defer remote.Close()
	config := &downloadIdentityConfigStore{values: map[string]any{
		"language":     "en",
		"enableDocker": true,
		"dockerUrl":    remote.URL,
		"apiKey":       "remote-key",
	}}
	server := New(core.NewTaskQueue(nil, 1), nil, nil, config)

	request := httptest.NewRequest(http.MethodPost, "/api/docker/downloads", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Engine().ServeHTTP(response, request)

	if response.Code != http.StatusOK || !bytes.Equal(remoteBody, payload) {
		t.Fatalf("response/body = %d %s / %s", response.Code, response.Body.String(), remoteBody)
	}
}
