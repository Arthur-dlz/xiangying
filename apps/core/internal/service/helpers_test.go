package service

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTestOutput(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCheckFileExistsFindsExactExtensionlessSocialVideo(t *testing.T) {
	dir := t.TempDir()
	name := "@motion.mistory · USA vs China [part 1]"
	want := filepath.Join(dir, name)
	writeTestOutput(t, want, "mp4 bytes")

	exists, got := CheckFileExists(name, dir)
	if !exists || got != want {
		t.Fatalf("CheckFileExists() = (%v, %q), want (true, %q)", exists, got, want)
	}
}

func TestCheckFileExistsPrefersFinalMediaOverFormatFragments(t *testing.T) {
	dir := t.TempDir()
	name := "download"
	writeTestOutput(t, filepath.Join(dir, name+".f137.mp4"), "large temporary video fragment")
	want := filepath.Join(dir, name+".mp4")
	writeTestOutput(t, want, "final")

	exists, got := CheckFileExists(name, dir)
	if !exists || got != want {
		t.Fatalf("CheckFileExists() = (%v, %q), want (true, %q)", exists, got, want)
	}
}

func TestCheckFileExistsDoesNotMatchAnotherTasksPrefix(t *testing.T) {
	dir := t.TempDir()
	writeTestOutput(t, filepath.Join(dir, "video-other.mp4"), "other")

	if exists, got := CheckFileExists("video", dir); exists {
		t.Fatalf("CheckFileExists() = (true, %q), want no match", got)
	}
}

func TestResolveOutputPathFindsPlayableFileInsideLegacyDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "multipart")
	writeTestOutput(t, filepath.Join(dir, "segment.ts"), "a much larger transport stream segment")
	want := filepath.Join(dir, "merged.mp4")
	writeTestOutput(t, want, "final")

	exists, got := ResolveOutputPath(dir)
	if !exists || got != want {
		t.Fatalf("ResolveOutputPath() = (%v, %q), want (true, %q)", exists, got, want)
	}
}

func TestResolveOutputPathFromLogUsesLatestFinalArtifact(t *testing.T) {
	dir := t.TempDir()
	name := "social.video"
	fragment := filepath.Join(dir, name+".f140.m4a")
	writeTestOutput(t, fragment, "audio")
	want := filepath.Join(dir, name+".mp4")
	writeTestOutput(t, want, "merged video")
	log := "[download] Destination: " + fragment + "\n[Merger] Merging formats into \"" + want + "\"\n"

	exists, got := ResolveOutputPathFromLog(log, name, "")
	if !exists || got != want {
		t.Fatalf("ResolveOutputPathFromLog() = (%v, %q), want (true, %q)", exists, got, want)
	}
}

func TestResolveOutputPathFromLogRecoversExtensionlessOutput(t *testing.T) {
	dir := t.TempDir()
	name := "@creator · clip.with.dots"
	want := filepath.Join(dir, name)
	writeTestOutput(t, want, "legacy mp4 bytes")

	exists, got := ResolveOutputPathFromLog("[download] Destination: "+want, name, "")
	if !exists || got != want {
		t.Fatalf("ResolveOutputPathFromLog() = (%v, %q), want (true, %q)", exists, got, want)
	}
}
