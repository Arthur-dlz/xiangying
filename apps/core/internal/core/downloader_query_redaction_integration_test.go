package core

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/core/schema"
	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/tasklog"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

// TestPinnedAria2DoesNotExposeURLQueryInCallbacksLogsOrFailure verifies the
// real bundled aria2 output for a controlled local 404. The URL contains only
// a non-secret sentinel so the probe can report booleans without printing it.
func TestPinnedAria2DoesNotExposeURLQueryInCallbacksLogsOrFailure(t *testing.T) {
	ensureTestLogger()
	aria2Path := filepath.Clean(filepath.Join("..", "..", "..", "..", ".deps", "win32-x64", "aria2c.exe"))
	aria2Path, err := filepath.Abs(aria2Path)
	if err != nil {
		t.Fatal(err)
	}
	toolBytes, err := os.ReadFile(aria2Path)
	if err != nil {
		t.Skipf("pinned aria2 binary unavailable: %v", err)
	}
	toolHash := sha256.Sum256(toolBytes)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("controlled missing fixture"))
	}))
	defer server.Close()
	const sentinel = "dummyQuery"
	url := server.URL + "/missing.mp4?token=" + sentinel

	tempRoot := os.Getenv("LOCAL_TEMP")
	if tempRoot == "" {
		tempRoot = os.TempDir()
	}
	if err := os.MkdirAll(tempRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	outputDir, err := os.MkdirTemp(tempRoot, "aria2-query-redaction-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outputDir)

	observedCore, observedLogs := observer.New(zapcore.DebugLevel)
	previousLogger, previousSugar := logger.Logger, logger.Sugar
	logger.Logger = zap.New(observedCore)
	logger.Sugar = logger.Logger.Sugar()
	t.Cleanup(func() {
		logger.Logger, logger.Sugar = previousLogger, previousSugar
	})

	logs := tasklog.NewManager(filepath.Join(outputDir, "task-logs"))
	const taskID = TaskID("remediation-query-redaction")
	var messages []string
	var messagesMu sync.Mutex
	realRunner := runnerFunc(func(ctx context.Context, bin string, args []string, onLine func(string)) error {
		cmd := exec.CommandContext(ctx, bin, args...)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return err
		}
		if err := cmd.Start(); err != nil {
			return err
		}
		var readers sync.WaitGroup
		var scanErrors []error
		var scanErrorsMu sync.Mutex
		readLines := func(reader io.Reader) {
			defer readers.Done()
			scanner := bufio.NewScanner(reader)
			scanner.Buffer(make([]byte, 4*1024), 1024*1024)
			for scanner.Scan() {
				if onLine != nil {
					onLine(scanner.Text())
				}
			}
			if err := scanner.Err(); err != nil {
				scanErrorsMu.Lock()
				scanErrors = append(scanErrors, err)
				scanErrorsMu.Unlock()
			}
		}
		readers.Add(2)
		go readLines(stdout)
		go readLines(stderr)
		waitErr := cmd.Wait()
		readers.Wait()
		scanErrorsMu.Lock()
		defer scanErrorsMu.Unlock()
		return errors.Join(append(scanErrors, waitErr)...)
	})
	d := NewDownloader(
		map[DownloadType]string{TypeDirect: aria2Path},
		realRunner,
		schema.DefaultSchemas(),
		testDownloaderConfig{localDir: outputDir},
	)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, downloadErr := d.Download(ctx, DownloadParams{
		ID: taskID, Type: TypeDirect, URL: url, Name: "missing-fixture",
	}, Callbacks{OnMessage: func(event MessageEvent) {
		messagesMu.Lock()
		messages = append(messages, event.Message)
		messagesMu.Unlock()
		if appendErr := logs.Append(string(event.ID), event.Message); appendErr != nil {
			t.Errorf("append callback to task log: %v", appendErr)
		}
	}})
	if downloadErr == nil {
		t.Fatal("Download() succeeded for controlled 404 fixture")
	}

	messagesMu.Lock()
	callbackContent := strings.Join(messages, "\n")
	messagesMu.Unlock()
	taskLogContent, err := logs.Read(string(taskID))
	if err != nil {
		t.Fatalf("read task log: %v", err)
	}
	var structuredLogContent strings.Builder
	for _, entry := range observedLogs.All() {
		fmt.Fprintf(&structuredLogContent, "%s %#v\n", entry.Message, entry.ContextMap())
	}

	result := map[string]any{
		"aria2Path":                     aria2Path,
		"aria2Sha256":                   hex.EncodeToString(toolHash[:]),
		"fixtureStatus":                 http.StatusNotFound,
		"callbackMessageCount":          len(messages),
		"callbackContainsQuery":         strings.Contains(callbackContent, sentinel),
		"taskLogContainsQuery":          strings.Contains(taskLogContent, sentinel),
		"errorContainsQuery":            strings.Contains(downloadErr.Error(), sentinel),
		"structuredLoggerContainsQuery": strings.Contains(structuredLogContent.String(), sentinel),
		"downloadFailedAsExpected":      downloadErr != nil,
		"errorType":                     fmt.Sprintf("%T", downloadErr),
	}
	if evidenceDir := os.Getenv("MEDIAGO_INTERFACE_EVIDENCE_DIR"); evidenceDir != "" {
		if err := os.MkdirAll(evidenceDir, 0o700); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(evidenceDir, "aria2-query-redaction-probe.json"), encoded, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("query-redaction flags: callback=%t tasklog=%t error=%t structuredLogger=%t aria2=%s messages=%d errorType=%s",
		result["callbackContainsQuery"], result["taskLogContainsQuery"], result["errorContainsQuery"],
		result["structuredLoggerContainsQuery"], hex.EncodeToString(toolHash[:]), len(messages), result["errorType"])

	if result["callbackContainsQuery"] == true || result["taskLogContainsQuery"] == true ||
		result["errorContainsQuery"] == true || result["structuredLoggerContainsQuery"] == true {
		t.Error("controlled URL query sentinel leaked into a callback, task log, failure, or structured log")
	}
}
