package service

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func buildFakeFFmpeg(t *testing.T) string {
	t.Helper()
	tempDir := t.TempDir()
	source := filepath.Join(tempDir, "fake-ffmpeg.go")
	binary := filepath.Join(tempDir, "ffmpeg")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	program := `package main
import (
    "fmt"
    "os"
    "strings"
)
func main() {
    args := os.Args[1:]
    if len(args) > 0 && args[0] == "-hide_banner" {
        fmt.Fprintln(os.Stderr, "Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s")
        return
    }
    if len(args) == 0 { os.Exit(2) }
    for _, arg := range args { if strings.Contains(arg, "empty-output-trigger") { return } }
    output := args[len(args)-1]
    if err := os.WriteFile(output, []byte("converted"), 0600); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(2) }
    for _, arg := range args {
        if strings.Contains(arg, "fail-conversion") { fmt.Fprintln(os.Stderr, "synthetic conversion failure"); os.Exit(1) }
    }
}`
	if err := os.WriteFile(source, []byte(program), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("go", "build", "-o", binary, source)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build fake ffmpeg: %v: %s", err, output)
	}
	return binary
}

func TestStartSameFormatPublishesSeparateNumberedOutput(t *testing.T) {
	input := filepath.Join(t.TempDir(), "same.mp4")
	const original = "original input bytes"
	if err := os.WriteFile(input, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	converter := NewConverter(buildFakeFFmpeg(t))
	output, err := converter.Start(1, input, "mp4", "medium", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	inputBytes, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	if string(inputBytes) != original {
		t.Fatalf("input bytes changed to %q", inputBytes)
	}
	if output != filepath.Join(filepath.Dir(input), "same (1).mp4") {
		t.Fatalf("Start() output = %q, want numbered output", output)
	}
	outputBytes, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if string(outputBytes) != "converted" {
		t.Fatalf("output bytes = %q, want converted", outputBytes)
	}
}

func TestStartDoesNotPublishEmptyConversionOutput(t *testing.T) {
	input := filepath.Join(t.TempDir(), "empty-output-trigger.mp4")
	const original = "original input bytes"
	if err := os.WriteFile(input, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	converter := NewConverter(buildFakeFFmpeg(t))
	output, err := converter.Start(2, input, "mp4", "medium", nil)
	if err == nil {
		t.Fatalf("Start() returned success with output %q, want empty-output error", output)
	}
	if output != "" {
		t.Fatalf("Start() output = %q on failure, want empty path", output)
	}
	if contents, readErr := os.ReadFile(input); readErr != nil || string(contents) != original {
		t.Fatalf("input bytes = %q, err = %v", contents, readErr)
	}
	entries, readErr := os.ReadDir(filepath.Dir(input))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(input) {
		t.Fatalf("directory entries after empty conversion = %v, want only input", entries)
	}
}

func TestCompanionBinaryPathPreservesExtension(t *testing.T) {
	path := companionBinaryPath(filepath.Join("deps", "ffmpeg.exe"), "ffprobe")
	if got, want := filepath.Base(path), "ffprobe.exe"; got != want {
		t.Fatalf("companionBinaryPath() = %q, want %q", got, want)
	}

	if runtime.GOOS != "windows" {
		path = companionBinaryPath(filepath.Join("deps", "ffmpeg"), "ffprobe")
		if got, want := filepath.Base(path), "ffprobe"; got != want {
			t.Fatalf("companionBinaryPath() = %q, want %q", got, want)
		}
	}
}

func TestParseFFmpegDuration(t *testing.T) {
	output := "Duration: 01:02:03.50, start: 0.000000, bitrate: 601 kb/s"
	if got, want := parseFFmpegDuration(output), time.Hour+2*time.Minute+3500*time.Millisecond; got != want {
		t.Fatalf("parseFFmpegDuration() = %s, want %s", got, want)
	}
}

func TestFormatFFmpegFailureIdentifiesMissingAudio(t *testing.T) {
	err := formatFFmpegFailure("mp3", errors.New("exit status 1"), []string{
		"Output #0, mp3, to 'example.mp3':",
		"[out#0/mp3] Output file does not contain any stream",
	})
	if got, want := err.Error(), "source file has no audio stream"; got != want {
		t.Fatalf("formatFFmpegFailure() = %q, want %q", got, want)
	}
}

func TestFormatFFmpegFailureKeepsUsefulDetail(t *testing.T) {
	err := formatFFmpegFailure("mp4", errors.New("exit status 1"), []string{
		"Input #0, mov, from 'example.mov':",
		"example.mp4: Permission denied",
	})
	if !strings.Contains(err.Error(), "Permission denied") {
		t.Fatalf("formatFFmpegFailure() = %q, want permission detail", err)
	}
}
