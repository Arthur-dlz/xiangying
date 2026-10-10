package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/api/sse"
	"caorushizi.cn/mediago/internal/core"
	"caorushizi.cn/mediago/internal/db"
	"caorushizi.cn/mediago/internal/db/repo"
	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/service"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

type downloadHandlerCapture struct {
	params chan core.DownloadParams
}

func (d *downloadHandlerCapture) Download(_ context.Context, params core.DownloadParams, _ core.Callbacks) (core.DownloadResult, error) {
	d.params <- params
	return core.DownloadResult{PrimaryPath: "/downloads/xiaohongshu.mp4"}, nil
}

func (*downloadHandlerCapture) Config() interface{} { return nil }

func TestDownloadHandlerAutoStartAllowsPublicHeaders(t *testing.T) {
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
	repository := repo.NewVideoRepository(database)
	capture := &downloadHandlerCapture{params: make(chan core.DownloadParams, 1)}
	queue := core.NewTaskQueue(capture, 1)
	downloadSvc := service.NewDownloadTaskService(repository, queue, nil)
	handler := NewDownloadHandler(downloadSvc, newDiscoveryHandlerConfig(), sse.New())
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/downloads", handler.Create)

	response := performDiscoveryRequest(t, router, http.MethodPost, "/api/downloads", map[string]any{
		"startDownload": true,
		"tasks": []map[string]any{{
			"name":    "小红书作品",
			"type":    "xiaohongshu",
			"url":     "https://www.xiaohongshu.com/explore/abc123?xsec_token=signed-token",
			"headers": "Referer: https://www.xiaohongshu.com/",
		}},
	})
	if response.Code != http.StatusOK {
		t.Fatalf("download response = %d %s", response.Code, response.Body.String())
	}
	select {
	case params := <-capture.params:
		joined := strings.Join(params.Headers, "\n")
		if !strings.Contains(joined, "Referer: https://www.xiaohongshu.com/") {
			t.Fatalf("runtime queue headers = %s", joined)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for download")
	}

	videos, err := repository.FindAll("ASC")
	if err != nil || len(videos) != 1 {
		t.Fatalf("stored downloads = %+v, %v", videos, err)
	}
	if videos[0].Headers == nil || !strings.Contains(*videos[0].Headers, "Referer") {
		t.Fatalf("persisted headers = %v", videos[0].Headers)
	}
	waitForDownloadHandlerQueue(t, queue)
}

func waitForDownloadHandlerQueue(t *testing.T, queue *core.TaskQueue) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for queue.IsFull() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for download queue")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestDownloadHandlerRejectsPausedSensitiveHeadersBeforePersistence(t *testing.T) {
	previousLogger, previousSugar := logger.Logger, logger.Sugar
	logger.Logger = zap.NewNop()
	logger.Sugar = logger.Logger.Sugar()
	t.Cleanup(func() {
		logger.Logger = previousLogger
		logger.Sugar = previousSugar
	})

	var titleLookupHits, mediaSourceHits atomic.Int32
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/title":
			titleLookupHits.Add(1)
			_, _ = w.Write([]byte("<html><title>Local title</title></html>"))
		case "/media.mp4":
			mediaSourceHits.Add(1)
			_, _ = w.Write([]byte("fixture-media"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer fixture.Close()

	database, err := db.New(filepath.Join(t.TempDir(), "downloads.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	repository := repo.NewVideoRepository(database)
	capture := &downloadHandlerCapture{params: make(chan core.DownloadParams, 2)}
	queue := core.NewTaskQueue(capture, 1)
	downloadSvc := service.NewDownloadTaskService(repository, queue, nil)
	handler := NewDownloadHandler(downloadSvc, newDiscoveryHandlerConfig(), sse.New())
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/downloads", handler.Create)
	router.GET("/api/downloads/:id", handler.Get)

	const dummy = "paused-header-dummy-never-print"
	response := performDiscoveryRequest(t, router, http.MethodPost, "/api/downloads", map[string]any{
		"startDownload": false,
		"tasks": []map[string]any{
			{
				"type":    "bilibili",
				"url":     fixture.URL + "/title",
				"headers": "Referer: public-fixture",
			},
			{
				"type":    "direct",
				"name":    "paused-private-header",
				"url":     fixture.URL + "/media.mp4",
				"headers": "Cookie: " + dummy,
			},
		},
	})
	rows, err := repository.FindAll("ASC")
	if err != nil {
		t.Fatal(err)
	}
	privateHeaderPersisted := false
	if response.Code == http.StatusOK {
		var created struct {
			Data []struct {
				ID int64 `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
			t.Fatal(err)
		}
		if len(created.Data) > 1 {
			getResponse := performDiscoveryRequest(t, router, http.MethodGet, fmt.Sprintf("/api/downloads/%d", created.Data[1].ID), nil)
			var fetched struct {
				Data struct {
					Headers *string `json:"headers"`
				} `json:"data"`
			}
			if err := json.Unmarshal(getResponse.Body.Bytes(), &fetched); err != nil {
				t.Fatal(err)
			}
			privateHeaderPersisted = fetched.Data.Headers != nil && strings.Contains(*fetched.Data.Headers, dummy)
		}
	}
	if response.Code != http.StatusBadRequest || len(rows) != 0 || privateHeaderPersisted || titleLookupHits.Load() != 0 || mediaSourceHits.Load() != 0 {
		t.Fatalf("paused header policy probe: status=%d rows=%d gettask_headers_contain_dummy=%t title_lookup_hits=%d source_hits=%d; want rejection before all side effects", response.Code, len(rows), privateHeaderPersisted, titleLookupHits.Load(), mediaSourceHits.Load())
	}
}

func TestDownloadHandlerRejectsSensitiveHeadersAcrossActiveBatchBeforeCreation(t *testing.T) {
	previousLogger, previousSugar := logger.Logger, logger.Sugar
	logger.Logger = zap.NewNop()
	logger.Sugar = logger.Logger.Sugar()
	t.Cleanup(func() {
		logger.Logger = previousLogger
		logger.Sugar = previousSugar
	})

	var titleLookupHits atomic.Int32
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/title" {
			titleLookupHits.Add(1)
			_, _ = w.Write([]byte("<html><title>Local title</title></html>"))
			return
		}
		http.NotFound(w, r)
	}))
	defer fixture.Close()

	database, err := db.New(filepath.Join(t.TempDir(), "downloads.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	repository := repo.NewVideoRepository(database)
	capture := &downloadHandlerCapture{params: make(chan core.DownloadParams, 2)}
	queue := core.NewTaskQueue(capture, 1)
	downloadSvc := service.NewDownloadTaskService(repository, queue, nil)
	handler := NewDownloadHandler(downloadSvc, newDiscoveryHandlerConfig(), sse.New())
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/downloads", handler.Create)

	const dummy = "active-batch-header-dummy-never-print"
	response := performDiscoveryRequest(t, router, http.MethodPost, "/api/downloads", map[string]any{
		"startDownload": true,
		"tasks": []map[string]any{
			{"type": "bilibili", "url": fixture.URL + "/title", "headers": "Referer: public-fixture"},
			{"type": "direct", "name": "active-private-header", "url": fixture.URL + "/media.mp4", "headers": "X-Private-Session: " + dummy},
		},
	})
	rows, err := repository.FindAll("ASC")
	if err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusBadRequest || len(rows) != 0 || titleLookupHits.Load() != 0 || len(capture.params) != 0 || strings.Contains(response.Body.String(), dummy) {
		t.Fatalf("active batch header policy: status=%d rows=%d title_lookup_hits=%d runner_calls=%d response_contains_dummy=%t; want whole-batch rejection before side effects", response.Code, len(rows), titleLookupHits.Load(), len(capture.params), strings.Contains(response.Body.String(), dummy))
	}
}
