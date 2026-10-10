package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"caorushizi.cn/mediago/internal/core/schema"
	"caorushizi.cn/mediago/internal/outputpolicy"
)

func TestDownloadRejectsUnsupportedOutputFilesystemBeforeStageOrRunner(t *testing.T) {
	ensureTestLogger()
	root := t.TempDir()
	outputDir := filepath.Join(root, "not-created", "downloads")
	bin := filepath.Join(root, "yt-dlp.exe")
	if err := os.WriteFile(bin, []byte("test binary placeholder"), 0o600); err != nil {
		t.Fatal(err)
	}

	runnerCalls := 0
	d := NewDownloader(
		map[DownloadType]string{TypeYoutube: bin},
		runnerFunc(func(context.Context, string, []string, func(string)) error {
			runnerCalls++
			return nil
		}),
		schema.SchemaList{Schemas: []schema.Schema{defaultContractSchema(t, string(TypeYoutube))}},
		testDownloaderConfig{localDir: outputDir, desktop: true},
	)
	var checkedPath string
	d.outputFilesystemCheck = func(path string) error {
		checkedPath = path
		return outputpolicy.ErrUnsupportedFilesystem
	}

	_, err := d.Download(context.Background(), DownloadParams{
		ID: TaskID("ntfs-policy"), Type: TypeYoutube,
		URL: "https://example.invalid/video", Name: "fixture",
	}, Callbacks{})
	if !errors.Is(err, outputpolicy.ErrUnsupportedFilesystem) {
		t.Fatalf("Download() error = %v, want unsupported filesystem", err)
	}
	if checkedPath != outputDir {
		t.Fatalf("checked path = %q, want %q", checkedPath, outputDir)
	}
	if runnerCalls != 0 {
		t.Fatalf("runner calls = %d, want 0", runnerCalls)
	}
	if _, statErr := os.Stat(filepath.Join(root, "not-created")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("filesystem rejection created output/stage parent: stat error = %v", statErr)
	}
}
