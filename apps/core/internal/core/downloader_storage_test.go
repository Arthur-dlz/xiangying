package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/core/schema"
)

func storageArgValue(args []string, flag string) string {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == flag {
			return args[index+1]
		}
	}
	return ""
}

func storageDirectoryFlag(downloadType DownloadType) string {
	switch downloadType {
	case TypeM3U8, TypeMediago:
		return "--save-dir"
	case TypeBilibili:
		return "--work-dir"
	case TypeDirect:
		return "-d"
	default:
		return "-P"
	}
}

func TestDownloadStagesAndPublishesAllEngineOutputsWithoutReplacingFiles(t *testing.T) {
	ensureTestLogger()
	tests := []DownloadType{TypeM3U8, TypeBilibili, TypeDirect, TypeMediago, TypeYoutube, TypeXiaohongshu}
	for _, downloadType := range tests {
		t.Run(string(downloadType), func(t *testing.T) {
			outputDir := t.TempDir()
			bin := filepath.Join(t.TempDir(), "downloader")
			if err := os.WriteFile(bin, []byte("test"), 0o700); err != nil {
				t.Fatal(err)
			}
			const sentinel = "keep these original bytes"
			sentinelPath := filepath.Join(outputDir, "video.mp4")
			if err := os.WriteFile(sentinelPath, []byte(sentinel), 0o600); err != nil {
				t.Fatal(err)
			}

			var stagePath string
			d := NewDownloader(map[DownloadType]string{downloadType: bin}, runnerFunc(func(_ context.Context, _ string, args []string, _ func(string)) error {
				stagePath = storageArgValue(args, storageDirectoryFlag(downloadType))
				if stagePath == "" {
					return fmt.Errorf("missing output directory argument %q", storageDirectoryFlag(downloadType))
				}
				if err := os.MkdirAll(stagePath, 0o700); err != nil {
					return err
				}
				return os.WriteFile(filepath.Join(stagePath, "video.mp4"), []byte("new media"), 0o600)
			}), schema.DefaultSchemas(), testDownloaderConfig{localDir: outputDir})

			result, err := d.Download(context.Background(), DownloadParams{
				ID: TaskID("storage-" + string(downloadType)), Type: downloadType,
				URL: "https://example.test/video.mp4", Name: "video",
			}, Callbacks{})
			if err != nil {
				t.Fatalf("Download() error = %v", err)
			}
			if filepath.Dir(stagePath) != outputDir || !strings.HasPrefix(filepath.Base(stagePath), ".mediago-stage-") {
				t.Fatalf("engine %s output directory = %q, want a private stage under %q", downloadType, stagePath, outputDir)
			}
			if want := filepath.Join(outputDir, "video (1).mp4"); result.PrimaryPath != want {
				t.Fatalf("Download() primary path = %q, want %q", result.PrimaryPath, want)
			}
			if got, err := os.ReadFile(sentinelPath); err != nil || string(got) != sentinel {
				t.Fatalf("existing output bytes = %q, err = %v", got, err)
			}
			if got, err := os.ReadFile(result.PrimaryPath); err != nil || string(got) != "new media" {
				t.Fatalf("published output bytes = %q, err = %v", got, err)
			}
			if _, err := os.Stat(stagePath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("temporary stage remains after success: %q, err = %v", stagePath, err)
			}
		})
	}
}

func TestDownloadFailureCleansOnlyItsStageAndPreservesExistingOutput(t *testing.T) {
	ensureTestLogger()
	outputDir := t.TempDir()
	bin := filepath.Join(t.TempDir(), "aria2c")
	if err := os.WriteFile(bin, []byte("test"), 0o700); err != nil {
		t.Fatal(err)
	}
	const sentinel = "existing output"
	sentinelPath := filepath.Join(outputDir, "video.mp4")
	if err := os.WriteFile(sentinelPath, []byte(sentinel), 0o600); err != nil {
		t.Fatal(err)
	}
	runnerFailure := errors.New("synthetic download failure")
	var stagePath string
	d := NewDownloader(map[DownloadType]string{TypeDirect: bin}, runnerFunc(func(_ context.Context, _ string, args []string, _ func(string)) error {
		stagePath = storageArgValue(args, "-d")
		if err := os.MkdirAll(stagePath, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(stagePath, "video.mp4"), []byte("partial"), 0o600); err != nil {
			return err
		}
		return runnerFailure
	}), schema.DefaultSchemas(), testDownloaderConfig{localDir: outputDir})

	_, err := d.Download(context.Background(), DownloadParams{ID: "storage-failure", Type: TypeDirect, URL: "https://example.test/video.mp4", Name: "video"}, Callbacks{})
	if !errors.Is(err, runnerFailure) {
		t.Fatalf("Download() error = %v, want runner failure", err)
	}
	if got, err := os.ReadFile(sentinelPath); err != nil || string(got) != sentinel {
		t.Fatalf("existing output bytes = %q, err = %v", got, err)
	}
	if _, err := os.Stat(stagePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed task stage remains: %q, err = %v", stagePath, err)
	}
}

func TestConcurrentDownloadsReserveDistinctOutputs(t *testing.T) {
	ensureTestLogger()
	outputDir := t.TempDir()
	bin := filepath.Join(t.TempDir(), "aria2c")
	if err := os.WriteFile(bin, []byte("test"), 0o700); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	d := NewDownloader(map[DownloadType]string{TypeDirect: bin}, runnerFunc(func(_ context.Context, _ string, args []string, _ func(string)) error {
		stagePath := storageArgValue(args, "-d")
		if err := os.MkdirAll(stagePath, 0o700); err != nil {
			return err
		}
		started <- struct{}{}
		<-release
		return os.WriteFile(filepath.Join(stagePath, "video.mp4"), []byte(filepath.Base(stagePath)), 0o600)
	}), schema.DefaultSchemas(), testDownloaderConfig{localDir: outputDir})

	type downloadResult struct {
		result DownloadResult
		err    error
	}
	results := make([]downloadResult, 2)
	var wg sync.WaitGroup
	var releaseOnce sync.Once
	defer func() {
		releaseOnce.Do(func() { close(release) })
		wg.Wait()
	}()
	for index := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			results[index].result, results[index].err = d.Download(context.Background(), DownloadParams{
				ID: TaskID(fmt.Sprintf("storage-concurrent-%d", index)), Type: TypeDirect,
				URL: "https://example.test/video.mp4", Name: "video",
			}, Callbacks{})
		}(index)
	}
	for index := 0; index < len(results); index++ {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatalf("only %d download runners started; want %d", index, len(results))
		}
	}
	releaseOnce.Do(func() { close(release) })
	wg.Wait()

	seen := map[string]struct{}{}
	for index, result := range results {
		if result.err != nil {
			t.Fatalf("Download[%d] error = %v", index, result.err)
		}
		if _, exists := seen[result.result.PrimaryPath]; exists {
			t.Fatalf("concurrent tasks published the same path %q", result.result.PrimaryPath)
		}
		seen[result.result.PrimaryPath] = struct{}{}
	}
	if len(seen) != 2 {
		t.Fatalf("published output count = %d, want 2", len(seen))
	}
}

func TestPublishDownloadArtifactsPreservesNestedSameExtensionPaths(t *testing.T) {
	outputDir := t.TempDir()
	stageDir, err := createDownloadStage(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(stageDir)

	first := filepath.Join(stageDir, "video", "nested", "a.mp4")
	second := filepath.Join(stageDir, "video", "nested", "b.mp4")
	if err := os.MkdirAll(filepath.Dir(first), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(first, []byte("first-media"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("second-media"), 0o600); err != nil {
		t.Fatal(err)
	}
	occupied := filepath.Join(outputDir, "video", "nested", "a.mp4")
	if err := os.MkdirAll(filepath.Dir(occupied), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(occupied, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := publishDownloadArtifacts(outputDir, stageDir, "video", []string{first, second})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		filepath.Join(outputDir, "video (1)", "nested", "a.mp4"),
		filepath.Join(outputDir, "video (1)", "nested", "b.mp4"),
	}
	if !slices.Equal(got, want) {
		t.Fatalf("published paths = %v, want %v", got, want)
	}
	for index, expected := range []string{"first-media", "second-media"} {
		data, err := os.ReadFile(got[index])
		if err != nil || string(data) != expected {
			t.Fatalf("published[%d] = %q, err = %v", index, data, err)
		}
	}
	if data, err := os.ReadFile(occupied); err != nil || string(data) != "sentinel" {
		t.Fatalf("existing nested output = %q, err = %v", data, err)
	}

	leafSource := filepath.Join(stageDir, "extras", "video.mp4")
	if err := os.MkdirAll(filepath.Dir(leafSource), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(leafSource, []byte("nested-task-stem"), 0o600); err != nil {
		t.Fatal(err)
	}
	leafOccupied := filepath.Join(outputDir, "extras", "video.mp4")
	if err := os.MkdirAll(filepath.Dir(leafOccupied), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(leafOccupied, []byte("nested-sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	leafPublished, err := publishDownloadArtifacts(outputDir, stageDir, "video", []string{leafSource})
	if err != nil {
		t.Fatal(err)
	}
	wantLeaf := filepath.Join(outputDir, "extras", "video (2).mp4")
	if !slices.Equal(leafPublished, []string{wantLeaf}) {
		t.Fatalf("nested task-stem paths = %v, want [%q]", leafPublished, wantLeaf)
	}
	if data, err := os.ReadFile(leafOccupied); err != nil || string(data) != "nested-sentinel" {
		t.Fatalf("existing nested stem output = %q, err = %v", data, err)
	}
}

func TestPublishDownloadArtifactsFailsClosedForUnnumberableNestedCollision(t *testing.T) {
	outputDir := t.TempDir()
	stageDir, err := createDownloadStage(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(stageDir)

	source := filepath.Join(stageDir, "unmatched", "a.mp4")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	occupied := filepath.Join(outputDir, "unmatched", "a.mp4")
	if err := os.MkdirAll(filepath.Dir(occupied), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(occupied, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := publishDownloadArtifacts(outputDir, stageDir, "video", []string{source}); err == nil {
		t.Fatal("expected an unnumberable nested collision to fail closed")
	}
	if data, err := os.ReadFile(occupied); err != nil || string(data) != "sentinel" {
		t.Fatalf("existing nested output = %q, err = %v", data, err)
	}
}

func TestRenamedStorageRelativePathChangesOnlyKnownTaskStem(t *testing.T) {
	tests := []struct {
		name, relative, want string
	}{
		{name: "top-level task directory", relative: filepath.Join("video", "nested", "a.mp4"), want: filepath.Join("video (1)", "nested", "a.mp4")},
		{name: "nested task leaf", relative: filepath.Join("extras", "video.mp4"), want: filepath.Join("extras", "video (1).mp4")},
		{name: "unmatched nested basename", relative: filepath.Join("extras", "a.mp4"), want: filepath.Join("extras", "a.mp4")},
		{name: "same extension other leaf", relative: filepath.Join("video", "nested", "b.mp4"), want: filepath.Join("video (1)", "nested", "b.mp4")},
		{name: "task stem prefix", relative: "video.P1.mp4", want: "video (1).P1.mp4"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := renamedStorageRelativePath(test.relative, "video", "video (1)"); got != test.want {
				t.Fatalf("renamedStorageRelativePath(%q) = %q, want %q", test.relative, got, test.want)
			}
		})
	}
}

func TestPublishDownloadArtifactsRejectsSameSourceAliasWithoutRetry(t *testing.T) {
	outputDir := t.TempDir()
	stageDir, err := createDownloadStage(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(stageDir)
	source := filepath.Join(stageDir, "video.mp4")
	if err := os.WriteFile(source, []byte("media"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := publishDownloadArtifacts(outputDir, stageDir, "video", []string{source, source}); err == nil {
		t.Fatal("expected aliased artifact paths to fail explicitly")
	}
	if _, err := os.Stat(filepath.Join(outputDir, "video.mp4")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("aliased publish left a public output behind: err = %v", err)
	}
}

func TestPublishDownloadArtifactsRejectsDuplicateMappedTargets(t *testing.T) {
	outputDir := t.TempDir()
	stageDir, err := createDownloadStage(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(stageDir)
	first := filepath.Join(stageDir, "video", "a.mp4")
	second := filepath.Join(stageDir, "video (1)", "a.mp4")
	for index, path := range []string{first, second} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(fmt.Sprintf("media-%d", index)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	sentinel := filepath.Join(outputDir, "video", "a.mp4")
	if err := os.MkdirAll(filepath.Dir(sentinel), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sentinel, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := publishDownloadArtifacts(outputDir, stageDir, "video", []string{first, second}); err == nil {
		t.Fatal("expected duplicate mapped outputs to fail explicitly")
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "sentinel" {
		t.Fatalf("existing output = %q, err = %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(outputDir, "video (1)", "a.mp4")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("duplicate mapping left a published output behind: err = %v", err)
	}
}
