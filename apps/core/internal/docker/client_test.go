package docker

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testConfig struct {
	values map[string]any
}

func (c *testConfig) Get(key string) any { return c.values[key] }

func TestClientForwardsRequestWithCurrentConfig(t *testing.T) {
	var receivedBody string
	var receivedAPIKey string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/prefix/api/downloads" || r.URL.RawQuery != "source=home" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.String())
		}
		body, _ := io.ReadAll(r.Body)
		receivedBody = string(body)
		receivedAPIKey = r.Header.Get("X-API-Key")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"success":true,"data":{"id":7}}`))
	}))
	defer remote.Close()

	config := &testConfig{values: map[string]any{
		"enableDocker": true,
		"dockerUrl":    remote.URL + "/prefix/",
		"apiKey":       "docker-key",
	}}
	client := NewClient(config)
	payload := `{"tasks":[{"url":"https://example.com/play","headers":"Cookie: secret"}],"startDownload":true}`
	response, err := client.Forward(context.Background(), "127.0.0.1:8899", ForwardRequest{
		Method:         http.MethodPost,
		Path:           "/api/downloads",
		RawQuery:       "source=home",
		Body:           strings.NewReader(payload),
		ContentType:    "application/json",
		AcceptLanguage: "zh-CN",
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusAccepted || response.ContentType != "application/json" {
		t.Fatalf("unexpected response: %+v", response)
	}
	if receivedBody != payload || receivedAPIKey != "docker-key" {
		t.Fatalf("body/key = %q / %q", receivedBody, receivedAPIKey)
	}

	second := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		receivedAPIKey = r.Header.Get("X-API-Key")
	}))
	defer second.Close()
	config.values["dockerUrl"] = second.URL
	config.values["apiKey"] = "rotated-key"
	if _, err := client.Forward(context.Background(), "127.0.0.1:8899", ForwardRequest{
		Method: http.MethodGet,
		Path:   "/api/downloads",
	}); err != nil {
		t.Fatal(err)
	}
	if receivedAPIKey != "rotated-key" {
		t.Fatalf("dynamic API key = %q", receivedAPIKey)
	}
}

func TestClientRejectsDisabledInvalidAndRecursiveTargets(t *testing.T) {
	tests := []struct {
		name         string
		values       map[string]any
		incomingHost string
		want         error
	}{
		{
			name: "disabled",
			values: map[string]any{
				"enableDocker": false,
				"dockerUrl":    "https://docker.example",
			},
			want: ErrDisabled,
		},
		{
			name: "invalid scheme",
			values: map[string]any{
				"enableDocker": true,
				"dockerUrl":    "file:///tmp/docker.sock",
			},
			want: ErrInvalidTarget,
		},
		{
			name: "recursive",
			values: map[string]any{
				"enableDocker": true,
				"dockerUrl":    "http://127.0.0.1:8899",
			},
			incomingHost: "127.0.0.1:8899",
			want:         ErrRecursiveTarget,
		},
		{
			name: "recursive loopback alias",
			values: map[string]any{
				"enableDocker": true,
				"dockerUrl":    "http://localhost:8899",
			},
			incomingHost: "127.0.0.1:8899",
			want:         ErrRecursiveTarget,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := NewClient(&testConfig{values: test.values})
			_, err := client.Forward(context.Background(), test.incomingHost, ForwardRequest{
				Method: http.MethodGet,
				Path:   "/api/downloads",
			})
			if !strings.Contains(err.Error(), test.want.Error()) {
				t.Fatalf("Forward() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestClientRejectsHTTPSDowngradeRedirect(t *testing.T) {
	redirectTargetCalled := false
	var remote *httptest.Server
	remote = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/downgraded" {
			redirectTargetCalled = true
			return
		}
		http.Redirect(w, r, strings.Replace(remote.URL, "https://", "http://", 1)+"/downgraded", http.StatusFound)
	}))
	defer remote.Close()

	client := NewClient(&testConfig{values: map[string]any{
		"enableDocker": true,
		"dockerUrl":    remote.URL,
		"apiKey":       "must-not-leak",
	}})
	client.transport = remote.Client().Transport
	_, err := client.Forward(context.Background(), "127.0.0.1:8899", ForwardRequest{
		Method: http.MethodGet,
		Path:   "/api/downloads",
	})
	if err == nil || redirectTargetCalled || !strings.Contains(err.Error(), "downgraded HTTPS") {
		t.Fatalf("redirect error/called = %v / %t", err, redirectTargetCalled)
	}
}

func TestClientDoesNotFollowCrossHostRedirects(t *testing.T) {
	redirectTargetCalled := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirectTargetCalled = true
	}))
	defer target.Close()
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/stolen", http.StatusFound)
	}))
	defer remote.Close()

	client := NewClient(&testConfig{values: map[string]any{
		"enableDocker": true,
		"dockerUrl":    remote.URL,
		"apiKey":       "must-not-leak",
	}})
	_, err := client.Forward(context.Background(), "127.0.0.1:8899", ForwardRequest{
		Method: http.MethodGet,
		Path:   "/api/downloads",
	})
	if err == nil || redirectTargetCalled {
		t.Fatalf("redirect error/called = %v / %t", err, redirectTargetCalled)
	}
}
