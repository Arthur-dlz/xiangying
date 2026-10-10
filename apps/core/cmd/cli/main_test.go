package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAPIClientCreatesPersistedDownload(t *testing.T) {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthy" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.URL.Path != "/api/downloads" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("Authorization = %q", got)
		}
		var request createDownloadRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if !request.StartDownload || len(request.Tasks) != 1 {
			t.Fatalf("unexpected request: %+v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"code":200,"data":[{"id":42,"name":"video","status":"pending"}]}`))
	}))
	defer server.Close()

	client, err := newAPIClient(server.URL, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.health(context.Background()); err != nil {
		t.Fatal(err)
	}
	record, err := client.createDownload(context.Background(), createDownloadTask{
		Type: "m3u8",
		URL:  "https://example.com/video.m3u8",
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.ID != 42 || record.Name != "video" {
		t.Fatalf("unexpected record: %+v", record)
	}
}

func TestDownloadCommandInfersYTDLPForXStatusURL(t *testing.T) {
	typeReceived := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthy":
			w.WriteHeader(http.StatusOK)
		case "/api/downloads":
			var request createDownloadRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if len(request.Tasks) != 1 {
				t.Fatalf("unexpected request: %+v", request)
			}
			typeReceived <- request.Tasks[0].Type
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"code":200,"data":[{"id":42,"name":"x-video","status":"pending"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	command := newRootCommand()
	command.SetArgs([]string{
		"--base-url", server.URL,
		"--config", filepath.Join(t.TempDir(), "missing.json"),
		"download", "https://x.com/mediago/status/1234567890",
		"--no-wait",
	})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if got := <-typeReceived; got != "youtube" {
		t.Fatalf("download type = %q, want youtube", got)
	}
}

func TestDiscoverCommandPrintsOnlyRedactedDataJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthy":
			w.WriteHeader(http.StatusOK)
		case "/api/discoveries":
			var input discoveryInput
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input.UseSessionCookies || input.TimeoutMS != 20_000 || input.Mode != "inspect" {
				t.Fatalf("unexpected discovery input: %+v", input)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"code":200,"message":"OK","data":{"id":"job-1","input":{"url":"https://cdn.example.com/master.m3u8","mode":"inspect","timeoutMs":20000,"useSessionCookies":false},"status":"completed","sources":[{"id":"source-1","url":"https://cdn.example.com/master.m3u8","pageUrl":"https://example.com/watch","title":"Example","type":"m3u8","playlistType":"master","maxQuality":"1080p"}],"partial":false}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	output := new(bytes.Buffer)
	command := newRootCommand()
	command.SetOut(output)
	command.SetErr(new(bytes.Buffer))
	command.SetArgs([]string{
		"--base-url", server.URL,
		"--config", filepath.Join(t.TempDir(), "missing.json"),
		"discover", "https://cdn.example.com/master.m3u8",
		"--mode", "inspect",
		"--json",
	})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	var job discoveryJob
	if err := json.Unmarshal(output.Bytes(), &job); err != nil {
		t.Fatalf("JSON output is not the API data object: %v: %s", err, output.String())
	}
	if job.ID != "job-1" || job.Status != "completed" || len(job.Sources) != 1 {
		t.Fatalf("unexpected JSON job: %+v", job)
	}
	for _, forbidden := range []string{"success", "sentinel", "authorization", "headers"} {
		if strings.Contains(strings.ToLower(output.String()), forbidden) {
			t.Fatalf("JSON output leaked envelope or credentials %q: %s", forbidden, output.String())
		}
	}
}

func TestAPIClientDiscoveryLifecycleAndBoundedPolling(t *testing.T) {
	var gets atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/discoveries/job-1":
			status := "running"
			if gets.Add(1) >= 2 {
				status = "completed"
			}
			_, _ = w.Write([]byte(`{"success":true,"code":200,"data":{"id":"job-1","input":{"timeoutMs":3000},"status":"` + status + `","sources":[],"partial":false}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/discoveries/job-1/cancel":
			_, _ = w.Write([]byte(`{"success":true,"code":200,"data":{"id":"job-1","status":"cancelled","sources":[],"partial":false}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/discoveries/job-1/downloads":
			var input discoveryDownloadsRequest
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if !input.StartDownload || len(input.SourceIDs) != 1 || input.SourceIDs[0] != "source-1" {
				t.Fatalf("unexpected download handoff: %+v", input)
			}
			_, _ = w.Write([]byte(`{"success":true,"code":200,"data":[{"id":42,"name":"Example","status":"ready"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client, err := newAPIClient(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	job, err := client.waitForDiscovery(context.Background(), "job-1", time.Second)
	if err != nil || job.Status != "completed" {
		t.Fatalf("wait result = %+v, %v", job, err)
	}
	cancelled, err := client.cancelDiscovery(context.Background(), "job-1")
	if err != nil || cancelled.Status != "cancelled" {
		t.Fatalf("cancel result = %+v, %v", cancelled, err)
	}
	records, err := client.downloadDiscovery(context.Background(), "job-1", discoveryDownloadsRequest{
		SourceIDs:     []string{"source-1"},
		StartDownload: true,
	})
	if err != nil || len(records) != 1 || records[0].ID != 42 {
		t.Fatalf("download result = %+v, %v", records, err)
	}
	if got := boundedDiscoveryWait(40_000); got != 35*time.Second {
		t.Fatalf("bounded wait = %v, want 35s", got)
	}
}

func TestAPIClientPreservesDiscoveryErrorCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"success":false,"code":409,"message":"browser executor unavailable","errorCode":"discovery_executor_unavailable"}`))
	}))
	defer server.Close()

	client, err := newAPIClient(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.createDiscovery(context.Background(), discoveryInput{
		URL:       "https://example.com/watch",
		Mode:      "browser",
		TimeoutMS: 20_000,
	})
	if err == nil || !strings.Contains(err.Error(), "discovery_executor_unavailable") {
		t.Fatalf("missing stable discovery error code: %v", err)
	}
}

func TestDiscoverCommandCancellationCallsServer(t *testing.T) {
	var cancelled atomic.Bool
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/healthy":
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Path == "/api/discoveries":
			_, _ = w.Write([]byte(`{"success":true,"code":202,"data":{"id":"job-1","input":{"timeoutMs":20000},"status":"pending","sources":[],"partial":false}}`))
			time.AfterFunc(20*time.Millisecond, cancel)
		case r.Method == http.MethodGet && r.URL.Path == "/api/discoveries/job-1":
			_, _ = w.Write([]byte(`{"success":true,"code":200,"data":{"id":"job-1","input":{"timeoutMs":20000},"status":"pending","sources":[],"partial":false}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/discoveries/job-1/cancel":
			cancelled.Store(true)
			_, _ = w.Write([]byte(`{"success":true,"code":200,"data":{"id":"job-1","status":"cancelled","sources":[],"partial":false}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	output := new(bytes.Buffer)
	command := newRootCommand()
	command.SetOut(output)
	command.SetArgs([]string{
		"--base-url", server.URL,
		"--config", filepath.Join(t.TempDir(), "missing.json"),
		"discover", "https://example.com/watch",
	})
	if err := command.ExecuteContext(ctx); err != nil {
		t.Fatal(err)
	}
	if !cancelled.Load() || !strings.Contains(output.String(), "cancelled") {
		t.Fatalf("cancellation was not propagated: cancelled=%v output=%q", cancelled.Load(), output.String())
	}
}

func TestLoadConfigDefaultsAndFile(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing.json")
	cfg, err := loadConfig(missing)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != defaultBaseURL {
		t.Fatalf("default base URL = %q", cfg.BaseURL)
	}

	path := filepath.Join(t.TempDir(), "cli.json")
	if err := os.WriteFile(path, []byte(`{"baseUrl":"http://localhost:9999","apiKey":"key"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err = loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != "http://localhost:9999" || cfg.APIKey != "key" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}
