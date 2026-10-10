package core

import (
	"bufio"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/core/schema"
)

func TestPinnedAria2DownloadsSameNameWithoutReplacingExistingOutput(t *testing.T) {
	ensureTestLogger()
	aria2Path := filepath.Clean(filepath.Join("..", "..", "..", "electron", "release-slim", "win-unpacked", "resources", "deps", "aria2c.exe"))
	aria2Path, err := filepath.Abs(aria2Path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(aria2Path); err != nil {
		t.Skipf("pinned aria2 binary unavailable: %v", err)
	}

	outputs := map[string][]byte{
		"/first/video.mp4":  []byte("first controlled aria2 fixture media"),
		"/second/video.mp4": []byte("second controlled aria2 fixture media"),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := outputs[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
	}))
	defer server.Close()

	outputDir := t.TempDir()
	sentinel := []byte("preexisting direct-download sentinel bytes")
	sentinelPath := filepath.Join(outputDir, "video.mp4")
	if err := os.WriteFile(sentinelPath, sentinel, 0o600); err != nil {
		t.Fatal(err)
	}

	realRunner := runnerFunc(func(ctx context.Context, bin string, args []string, onLine func(string)) error {
		cmd := exec.CommandContext(ctx, bin, args...)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			return err
		}
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if onLine != nil {
				onLine(scanner.Text())
			}
		}
		scanErr := scanner.Err()
		waitErr := cmd.Wait()
		if scanErr != nil || waitErr != nil {
			return fmt.Errorf("aria2 execution failed: %w", errors.Join(scanErr, waitErr))
		}
		return nil
	})
	d := NewDownloader(map[DownloadType]string{TypeDirect: aria2Path}, realRunner, schema.DefaultSchemas(), testDownloaderConfig{localDir: outputDir})

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for index, path := range []string{"/first/video.mp4", "/second/video.mp4"} {
		result, err := d.Download(ctx, DownloadParams{
			ID: TaskID(fmt.Sprintf("aria2-same-name-%d", index)), Type: TypeDirect,
			URL: server.URL + path, Name: "video",
		}, Callbacks{})
		if err != nil {
			t.Fatalf("direct download %d failed: %v", index, err)
		}
		wantPath := filepath.Join(outputDir, fmt.Sprintf("video (%d).mp4", index+1))
		if result.PrimaryPath != wantPath {
			t.Fatalf("direct download %d path = %q, want %q", index, result.PrimaryPath, wantPath)
		}
		wantHash := sha256.Sum256(outputs[path])
		data, err := os.ReadFile(result.PrimaryPath)
		if err != nil {
			t.Fatal(err)
		}
		if gotHash := sha256.Sum256(data); gotHash != wantHash {
			t.Fatalf("direct download %d hash = %x, want %x", index, gotHash, wantHash)
		}
	}
	if got, err := os.ReadFile(sentinelPath); err != nil || string(got) != string(sentinel) {
		t.Fatalf("sentinel contents = %q, err = %v", got, err)
	}
}
