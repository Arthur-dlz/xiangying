package service

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"caorushizi.cn/mediago/internal/outputpolicy"
)

func TestConverterRejectsUnsupportedFilesystemBeforeStagingOrFFmpeg(t *testing.T) {
	outputDir := t.TempDir()
	inputPath := filepath.Join(outputDir, "input.mp4")
	if err := os.WriteFile(inputPath, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}

	converter := NewConverter(filepath.Join(outputDir, "must-not-run-ffmpeg.exe"))
	var checkedPath string
	converter.outputFilesystemCheck = func(path string) error {
		checkedPath = path
		return outputpolicy.ErrUnsupportedFilesystem
	}
	output, err := converter.Start(1, inputPath, "mp4", "medium", nil)
	if !errors.Is(err, outputpolicy.ErrUnsupportedFilesystem) {
		t.Fatalf("Start() error = %v, want unsupported filesystem", err)
	}
	if output != "" {
		t.Fatalf("Start() output = %q, want empty", output)
	}
	if checkedPath != outputDir {
		t.Fatalf("checked path = %q, want %q", checkedPath, outputDir)
	}
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(inputPath) {
		t.Fatalf("directory entries after rejection = %v, want only input (no staging file)", entries)
	}
}
