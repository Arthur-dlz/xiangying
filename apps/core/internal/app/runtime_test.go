package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/core"
	"caorushizi.cn/mediago/internal/db"
	"caorushizi.cn/mediago/internal/db/repo"
	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/service"
	"caorushizi.cn/mediago/pkg/conf"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func TestMigrateLegacyAppStoreDeletesMCPPort(t *testing.T) {
	store, err := conf.New(conf.Options[AppStore]{
		CWD:      t.TempDir(),
		Defaults: DefaultAppStore(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Set("mcpPort", 39720); err != nil {
		t.Fatal(err)
	}
	if err := store.Set("proxy", "http://127.0.0.1:7890"); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyAppStore(store); err != nil {
		t.Fatal(err)
	}
	if value := store.Get("mcpPort"); value != nil {
		t.Fatalf("mcpPort = %#v, want nil", value)
	}
	if value := store.Get("proxy"); value != "http://127.0.0.1:7890" {
		t.Fatalf("proxy = %#v, want preserved value", value)
	}

	data, err := os.ReadFile(store.Path())
	if err != nil {
		t.Fatal(err)
	}
	var persisted map[string]any
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if _, exists := persisted["mcpPort"]; exists {
		t.Fatal("persisted config still contains mcpPort")
	}
}

func TestMigrateLegacyAppStoreReportsWriteFailure(t *testing.T) {
	store, err := conf.New(conf.Options[AppStore]{
		CWD:      t.TempDir(),
		Defaults: DefaultAppStore(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Set("mcpPort", 39720); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(store.Path()+".tmp", 0o755); err != nil {
		t.Fatal(err)
	}

	err = migrateLegacyAppStore(store)
	if err == nil || !strings.Contains(err.Error(), "remove legacy mcpPort config") {
		t.Fatalf("migration error = %v, want legacy cleanup failure", err)
	}
	if value := store.Get("mcpPort"); value == nil {
		t.Fatal("failed migration did not restore the in-memory legacy value")
	}
}

func TestRuntimeLogsDoNotExposeProxyValues(t *testing.T) {
	observedCore, observedLogs := observer.New(zapcore.DebugLevel)
	observedLogger := zap.New(observedCore)
	previousLogger := logger.Logger
	previousSugar := logger.Sugar
	logger.Logger = observedLogger
	logger.Sugar = observedLogger.Sugar()
	t.Cleanup(func() {
		logger.Logger = previousLogger
		logger.Sugar = previousSugar
	})

	tempDir := t.TempDir()
	localDir := filepath.Join(tempDir, "downloads")
	if err := os.Mkdir(localDir, 0o755); err != nil {
		t.Fatal("runtime test setup failed")
	}

	startupUserMarker := "startup-user-7d2e6f"
	startupPasswordMarker := "startup-pass-a9c413"
	startupProxy := "http://" + startupUserMarker + ":" + startupPasswordMarker + "@127.0.0.1:39091"
	runtimeUserMarker := "runtime-user-b15c84"
	runtimePasswordMarker := "runtime-pass-e30d72"
	runtimeProxy := "http://" + runtimeUserMarker + ":" + runtimePasswordMarker + "@127.0.0.1:39092"

	cfg := &AppConfig{
		LogDir:     filepath.Join(tempDir, "logs"),
		SchemaPath: filepath.Join(tempDir, "missing-schema.json"),
		DepsDir:    filepath.Join(tempDir, "deps"),
		MaxRunner:  1,
		LocalDir:   localDir,
		Proxy:      startupProxy,
		ConfigDir:  filepath.Join(tempDir, "config"),
	}

	rt, err := NewRuntime(cfg)
	if err != nil {
		t.Fatal("runtime initialization failed")
	}
	t.Cleanup(rt.Close)

	if err := rt.AppStore.Set("proxy", runtimeProxy); err != nil {
		t.Fatal("runtime proxy update failed")
	}

	proxyPropagated := cfg.GetProxy() == runtimeProxy
	if !proxyPropagated {
		t.Fatal("runtime proxy propagation changed")
	}

	secretMarkers := []string{
		startupProxy,
		startupUserMarker,
		startupPasswordMarker,
		runtimeProxy,
		runtimeUserMarker,
		runtimePasswordMarker,
	}
	for _, entry := range observedLogs.All() {
		messageContainsSecret := containsAnyRuntimeLogSecret(entry.Message, secretMarkers)
		contextContainsSecret := containsAnyRuntimeLogSecret(fmt.Sprint(entry.ContextMap()), secretMarkers)
		if messageContainsSecret || contextContainsSecret {
			t.Fatal("runtime logs contain a proxy secret")
		}
	}

	updateMessageFound := observedLogs.FilterMessage("proxy updated via config change").Len() > 0
	if !updateMessageFound {
		t.Fatal("runtime proxy update log message missing")
	}
}

func TestRuntimeRestartMarksInterruptedDownloadsRetryable(t *testing.T) {
	previousLogger, previousSugar := logger.Logger, logger.Sugar
	testLogger := zap.NewNop()
	logger.Logger, logger.Sugar = testLogger, testLogger.Sugar()
	t.Cleanup(func() {
		logger.Logger, logger.Sugar = previousLogger, previousSugar
	})

	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "data", "downloads.db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("create database directory: %v", err)
	}
	database, err := db.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	videoRepository := repo.NewVideoRepository(database)
	statuses := []string{"pending", "downloading", "success", "failed", "stopped"}
	ids := make(map[string]int64, len(statuses))
	for _, status := range statuses {
		video, err := videoRepository.Create(&db.Video{
			Name:          "restart-" + status,
			Type:          "direct",
			URL:           "https://example.com/" + status,
			Status:        status,
			LastErrorCode: "previous-" + status,
		})
		if err != nil {
			t.Fatalf("create %s row: %v", status, err)
		}
		ids[status] = video.ID
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	config := &AppConfig{
		LogDir:     filepath.Join(tempDir, "logs"),
		SchemaPath: filepath.Join(tempDir, "missing-schema.json"),
		DepsDir:    filepath.Join(tempDir, "deps"),
		MaxRunner:  1,
		LocalDir:   filepath.Join(tempDir, "downloads"),
		ConfigDir:  filepath.Join(tempDir, "config"),
		DBPath:     dbPath,
	}
	runtime, err := NewRuntime(config)
	if err != nil {
		t.Fatalf("NewRuntime() error = %v", err)
	}
	t.Cleanup(func() {
		runtime.Close()
	})

	videoRepository = repo.NewVideoRepository(runtime.Database)
	for _, originalStatus := range statuses {
		video, err := videoRepository.FindByIDOrFail(ids[originalStatus])
		if err != nil {
			t.Fatalf("read %s row after restart: %v", originalStatus, err)
		}
		wantStatus, wantErrorCode := originalStatus, "previous-"+originalStatus
		if originalStatus == "pending" || originalStatus == "downloading" {
			wantStatus, wantErrorCode = "stopped", "download_interrupted"
		}
		if video.Status != wantStatus || video.LastErrorCode != wantErrorCode {
			t.Errorf("%s row after restart = status %q error %q; want %q / %q", originalStatus, video.Status, video.LastErrorCode, wantStatus, wantErrorCode)
		}
	}

	started := make(chan core.DownloadParams, 1)
	finished := make(chan struct{}, 1)
	queue := core.NewTaskQueue(restartProbeDownloader{started: started, finished: finished}, 1)
	downloadService := service.NewDownloadTaskService(videoRepository, queue, nil)
	resumeID := ids["downloading"]
	if err := downloadService.StartDownload(resumeID, config.LocalDir, false); err != nil {
		t.Fatalf("StartDownload() for recovered task error = %v", err)
	}
	select {
	case params := <-started:
		if params.ID != core.TaskID(strconv.FormatInt(resumeID, 10)) {
			t.Fatalf("started task ID = %q, want %d", params.ID, resumeID)
		}
	case <-time.After(time.Second):
		t.Fatal("recovered task was not enqueued for retry")
	}
	if err := queue.Stop(core.TaskID(strconv.FormatInt(resumeID, 10))); err != nil {
		t.Fatalf("stop retry probe task: %v", err)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("retry probe downloader did not stop")
	}
}

type restartProbeDownloader struct {
	started  chan<- core.DownloadParams
	finished chan<- struct{}
}

func (d restartProbeDownloader) Config() any { return nil }

func (d restartProbeDownloader) Download(ctx context.Context, params core.DownloadParams, _ core.Callbacks) (core.DownloadResult, error) {
	d.started <- params
	<-ctx.Done()
	d.finished <- struct{}{}
	return core.DownloadResult{}, ctx.Err()
}

func TestEnsureDownloadDirCreatesConfiguredDirectory(t *testing.T) {
	tempDir := t.TempDir()
	configDir := filepath.Join(tempDir, "config")
	store, err := conf.New(conf.Options[AppStore]{
		CWD:      configDir,
		Defaults: DefaultAppStore(),
	})
	if err != nil {
		t.Fatal(err)
	}

	localDir := filepath.Join(tempDir, "nested", "downloads")
	cfg := &AppConfig{LocalDir: localDir}
	ensureDownloadDir(store, cfg)

	info, err := os.Stat(localDir)
	if err != nil {
		t.Fatalf("configured download directory was not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("configured download path is not a directory: %s", localDir)
	}
	if cfg.LocalDir != localDir {
		t.Fatalf("LocalDir = %q, want %q", cfg.LocalDir, localDir)
	}
	if got := store.Store().Local; got != localDir {
		t.Fatalf("persisted local directory = %q, want %q", got, localDir)
	}
}

func containsAnyRuntimeLogSecret(value string, secrets []string) bool {
	for _, secret := range secrets {
		containsSecret := strings.Contains(value, secret)
		if containsSecret {
			return true
		}
	}
	return false
}
