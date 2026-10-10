package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/api/sse"
	"caorushizi.cn/mediago/internal/core"
	"caorushizi.cn/mediago/internal/db"
	"caorushizi.cn/mediago/internal/db/repo"
	"caorushizi.cn/mediago/internal/discovery"
	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/service"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

type discoveryHandlerExecutor struct {
	available bool
}

func (e *discoveryHandlerExecutor) Available() bool { return e.available }
func (*discoveryHandlerExecutor) Dispatch(context.Context, discovery.DiscoveryJob) error {
	return nil
}
func (*discoveryHandlerExecutor) Cancel(context.Context, string) error { return nil }

type discoveryHandlerInspector struct{}

func (discoveryHandlerInspector) Inspect(_ context.Context, input service.InspectSourceInput) service.SourceInspection {
	return service.SourceInspection{
		ID:           input.ID,
		URL:          input.URL,
		PlaylistType: "master",
		MaxQuality:   "1080p",
		Variants: []service.HLSVariant{{
			URL:     "https://cdn.example.com/1080.m3u8",
			Quality: "1080p",
			Height:  1080,
		}},
	}
}

type discoveryHandlerConfig struct {
	values map[string]any
}

func (c *discoveryHandlerConfig) Get(key string) any { return c.values[key] }
func (c *discoveryHandlerConfig) Set(key string, value any) error {
	c.values[key] = value
	return nil
}
func (c *discoveryHandlerConfig) Update(values map[string]any) error {
	for key, value := range values {
		c.values[key] = value
	}
	return nil
}
func (c *discoveryHandlerConfig) Store() any { return c.values }

func TestDiscoveryHandlerCreateGetCancelAndExecutorStatus(t *testing.T) {
	executor := &discoveryHandlerExecutor{}
	svc := discovery.NewService(discovery.NewStore(discovery.StoreOptions{Capacity: 20}), discoveryHandlerInspector{}, executor)
	router := newDiscoveryHandlerTestRouter(svc, nil, newDiscoveryHandlerConfig())

	unavailable := performDiscoveryRequest(t, router, http.MethodPost, "/api/discoveries", map[string]any{
		"url": "https://example.com/watch",
	})
	if unavailable.Code != http.StatusConflict || !strings.Contains(unavailable.Body.String(), "discovery_executor_unavailable") {
		t.Fatalf("unavailable response = %d %s", unavailable.Code, unavailable.Body.String())
	}

	executor.available = true
	created := performDiscoveryRequest(t, router, http.MethodPost, "/api/discoveries", map[string]any{
		"url":               "https://example.com/watch",
		"mode":              "browser",
		"useSessionCookies": true,
	})
	if created.Code != http.StatusAccepted {
		t.Fatalf("create response = %d %s", created.Code, created.Body.String())
	}
	jobID := responseDataString(t, created.Body.Bytes(), "id")

	getResponse := performDiscoveryRequest(t, router, http.MethodGet, "/api/discoveries/"+jobID, nil)
	if getResponse.Code != http.StatusOK || !strings.Contains(getResponse.Body.String(), `"status":"pending"`) {
		t.Fatalf("get response = %d %s", getResponse.Code, getResponse.Body.String())
	}
	cancelResponse := performDiscoveryRequest(t, router, http.MethodPost, "/api/discoveries/"+jobID+"/cancel", nil)
	if cancelResponse.Code != http.StatusOK || !strings.Contains(cancelResponse.Body.String(), `"status":"cancelled"`) {
		t.Fatalf("cancel response = %d %s", cancelResponse.Code, cancelResponse.Body.String())
	}
	statusResponse := performDiscoveryRequest(t, router, http.MethodGet, "/api/discovery-executor/status", nil)
	if statusResponse.Code != http.StatusOK || !strings.Contains(statusResponse.Body.String(), `"available":true`) {
		t.Fatalf("status response = %d %s", statusResponse.Code, statusResponse.Body.String())
	}
}

func TestDiscoveryHandlerCompletesInspectSynchronously(t *testing.T) {
	svc := discovery.NewService(discovery.NewStore(discovery.StoreOptions{}), discoveryHandlerInspector{}, nil)
	router := newDiscoveryHandlerTestRouter(svc, nil, newDiscoveryHandlerConfig())
	response := performDiscoveryRequest(t, router, http.MethodPost, "/api/discoveries", map[string]any{
		"url":  "https://cdn.example.com/master.m3u8",
		"mode": "inspect",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	for _, expected := range []string{`"status":"completed"`, `"playlistType":"master"`, `"maxQuality":"1080p"`} {
		if !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("response missing %s: %s", expected, response.Body.String())
		}
	}
}

func TestSelectedDiscoverySourceURLRejectsUnadvertisedVariant(t *testing.T) {
	source := discovery.DiscoverySource{
		ID:       "source-1",
		URL:      "https://cdn.example.com/master.m3u8",
		Variants: []discovery.HLSVariant{{URL: "https://cdn.example.com/720.m3u8"}},
	}

	selected, err := selectedDiscoverySourceURL(source, map[string]string{
		"source-1": "https://attacker.example/steal-credentials.m3u8",
	})
	if !errors.Is(err, ErrDiscoveryDownloadInvalid) || selected != "" {
		t.Fatalf("selected URL/error = %q, %v", selected, err)
	}
}

type discoveryDownloadCapture struct {
	params chan core.DownloadParams
}

func (d *discoveryDownloadCapture) Download(_ context.Context, params core.DownloadParams, _ core.Callbacks) (core.DownloadResult, error) {
	d.params <- params
	return core.DownloadResult{PrimaryPath: "/downloads/discovery.mp4"}, nil
}
func (*discoveryDownloadCapture) Config() interface{} { return nil }

func TestDiscoveryHandlerCreatesDownloadWithRuntimeOnlyCredentials(t *testing.T) {
	previousLogger, previousSugar := logger.Logger, logger.Sugar
	logger.Logger = zap.NewNop()
	logger.Sugar = logger.Logger.Sugar()
	t.Cleanup(func() {
		logger.Logger = previousLogger
		logger.Sugar = previousSugar
	})

	database, err := db.New(filepath.Join(t.TempDir(), "downloads.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	downloadCapture := &discoveryDownloadCapture{params: make(chan core.DownloadParams, 1)}
	queue := core.NewTaskQueue(downloadCapture, 1)
	downloadSvc := service.NewDownloadTaskService(repo.NewVideoRepository(database), queue, nil)
	executor := &discoveryHandlerExecutor{available: true}
	discoverySvc := discovery.NewService(discovery.NewStore(discovery.StoreOptions{}), nil, executor)
	job, err := discoverySvc.Create(context.Background(), discovery.CreateDiscoveryInput{
		URL:               "https://example.com/watch",
		Mode:              discovery.ModeBrowser,
		UseSessionCookies: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := discoverySvc.MarkRunning(job.ID); err != nil {
		t.Fatal(err)
	}
	completed, err := discoverySvc.Complete(context.Background(), job.ID, []discovery.PrivateSource{{
		DiscoverySource: discovery.DiscoverySource{
			ID:           "source-1",
			URL:          "https://cdn.example.com/master.m3u8",
			PageURL:      "https://example.com/watch",
			Title:        "Example",
			Type:         discovery.SourceTypeM3U8,
			PlaylistType: discovery.PlaylistTypeMaster,
			Variants: []discovery.HLSVariant{
				{URL: "https://cdn.example.com/1080.m3u8", Quality: "1080p"},
				{URL: "https://cdn.example.com/720.m3u8", Quality: "720p"},
			},
			DetectedAt: time.Now().UTC(),
		},
		Headers: []string{
			"Cookie: sentinel-cookie",
			"Authorization: Bearer sentinel-authorization",
			"Referer: https://example.com/watch",
		},
	}}, false)
	if err != nil || completed.Status != discovery.StatusCompleted {
		t.Fatalf("complete = %+v, %v", completed, err)
	}

	router := newDiscoveryHandlerTestRouter(discoverySvc, downloadSvc, newDiscoveryHandlerConfig())
	response := performDiscoveryRequest(t, router, http.MethodPost, "/api/discoveries/"+job.ID+"/downloads", map[string]any{
		"sourceIds":     []string{"source-1"},
		"variantUrls":   map[string]string{"source-1": "https://cdn.example.com/720.m3u8"},
		"startDownload": true,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("download response = %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "sentinel-") {
		t.Fatalf("download response leaked credentials: %s", response.Body.String())
	}

	select {
	case params := <-downloadCapture.params:
		if params.URL != "https://cdn.example.com/720.m3u8" {
			t.Fatalf("runtime queue URL = %s", params.URL)
		}
		joined := strings.Join(params.Headers, "\n")
		if !strings.Contains(joined, "sentinel-cookie") || !strings.Contains(joined, "sentinel-authorization") {
			t.Fatalf("runtime queue headers = %s", joined)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for download")
	}
	videos, err := downloadSvc.GetDownloadTasks(1, 20, "", "")
	if err != nil || len(videos.List) != 1 {
		t.Fatalf("stored downloads = %+v, %v", videos, err)
	}
	if videos.List[0].URL != "https://cdn.example.com/720.m3u8" {
		t.Fatalf("persisted URL = %s", videos.List[0].URL)
	}
	if videos.List[0].Headers == nil || strings.Contains(*videos.List[0].Headers, "sentinel-") || !strings.Contains(*videos.List[0].Headers, "Referer") {
		t.Fatalf("persisted headers = %v", videos.List[0].Headers)
	}
	waitForDiscoveryDownloadQueue(t, queue)
}

func TestDiscoveryHandlerSkipsExistingSourceWithoutFailingRemainingSources(t *testing.T) {
	previousLogger, previousSugar := logger.Logger, logger.Sugar
	logger.Logger = zap.NewNop()
	logger.Sugar = logger.Logger.Sugar()
	t.Cleanup(func() {
		logger.Logger = previousLogger
		logger.Sugar = previousSugar
	})

	database, err := db.New(filepath.Join(t.TempDir(), "downloads.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	downloadSvc := service.NewDownloadTaskService(repo.NewVideoRepository(database), nil, nil)
	if _, err := downloadSvc.AddDownloadTask(&service.AddDownloadTaskInput{
		Name: "Existing",
		Type: "m3u8",
		URL:  "https://cdn.example.com/existing.m3u8",
	}); err != nil {
		t.Fatal(err)
	}

	discoverySvc := discovery.NewService(discovery.NewStore(discovery.StoreOptions{}), nil, &discoveryHandlerExecutor{available: true})
	job, err := discoverySvc.Create(context.Background(), discovery.CreateDiscoveryInput{
		URL:  "https://example.com/watch",
		Mode: discovery.ModeBrowser,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := discoverySvc.MarkRunning(job.ID); err != nil {
		t.Fatal(err)
	}
	completed, err := discoverySvc.Complete(context.Background(), job.ID, []discovery.PrivateSource{
		{DiscoverySource: discovery.DiscoverySource{ID: "existing", URL: "https://cdn.example.com/existing.m3u8", Title: "Existing", Type: discovery.SourceTypeM3U8}},
		{DiscoverySource: discovery.DiscoverySource{ID: "new", URL: "https://cdn.example.com/new.m3u8", Title: "New", Type: discovery.SourceTypeM3U8}},
	}, false)
	if err != nil || completed.Status != discovery.StatusCompleted {
		t.Fatalf("complete = %+v, %v", completed, err)
	}

	router := newDiscoveryHandlerTestRouter(discoverySvc, downloadSvc, newDiscoveryHandlerConfig())
	response := performDiscoveryRequest(t, router, http.MethodPost, "/api/discoveries/"+job.ID+"/downloads", map[string]any{
		"sourceIds":     []string{"existing", "new"},
		"startDownload": false,
	})
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "https://cdn.example.com/new.m3u8") {
		t.Fatalf("download response = %d %s", response.Code, response.Body.String())
	}
	videos, err := downloadSvc.GetDownloadTasks(1, 20, "", "")
	if err != nil || videos.Total != 2 {
		t.Fatalf("stored downloads = %+v, %v", videos, err)
	}
}

func waitForDiscoveryDownloadQueue(t *testing.T, queue *core.TaskQueue) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for queue.IsFull() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for discovery download queue")
		}
		time.Sleep(time.Millisecond)
	}
}

func newDiscoveryHandlerConfig() *discoveryHandlerConfig {
	return &discoveryHandlerConfig{values: map[string]any{
		"language":       "en",
		"local":          "",
		"deleteSegments": false,
	}}
}

func newDiscoveryHandlerTestRouter(discoverySvc *discovery.Service, downloadSvc *service.DownloadTaskService, config ConfigStore) *gin.Engine {
	gin.SetMode(gin.TestMode)
	handler := NewDiscoveryHandler(discoverySvc, downloadSvc, config, sse.New())
	router := gin.New()
	router.POST("/api/discoveries", handler.Create)
	router.GET("/api/discoveries/:id", handler.Get)
	router.POST("/api/discoveries/:id/cancel", handler.Cancel)
	router.POST("/api/discoveries/:id/downloads", handler.Downloads)
	router.GET("/api/discovery-executor/status", handler.ExecutorStatus)
	return router
}

func performDiscoveryRequest(t *testing.T, router http.Handler, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var requestBody *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		requestBody = bytes.NewReader(encoded)
	}
	var request *http.Request
	if requestBody == nil {
		request = httptest.NewRequest(method, target, nil)
	} else {
		request = httptest.NewRequest(method, target, requestBody)
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func responseDataString(t *testing.T, encoded []byte, key string) string {
	t.Helper()
	var response struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	value, _ := response.Data[key].(string)
	if value == "" {
		t.Fatalf("response data missing %q: %s", key, encoded)
	}
	return value
}
