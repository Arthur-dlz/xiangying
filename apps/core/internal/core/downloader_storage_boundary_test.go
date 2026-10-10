package core

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPublicationRollbackReturnsNonNotExistStatError(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows invalid filename produces a deterministic non-NotExist Stat error")
	}

	root := t.TempDir()
	source := filepath.Join(root, "source.mp4")
	if err := os.WriteFile(source, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourceInfo, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	invalidTarget := filepath.Join(root, "invalid?target.mp4")
	_, statErr := os.Stat(invalidTarget)
	if statErr == nil {
		t.Fatal("expected Windows Stat to reject an invalid filename")
	}
	if errors.Is(statErr, fs.ErrNotExist) {
		t.Fatalf("invalid filename produced a NotExist error, need deterministic other Stat error: %v", statErr)
	}

	err = rollbackStoragePublication([]storageLink{{target: invalidTarget, sourceInfo: sourceInfo}}, nil)
	if err == nil {
		t.Fatal("rollback silently ignored a non-NotExist Stat error")
	}
	var pathErr *os.PathError
	if !errors.As(statErr, &pathErr) || !errors.Is(err, pathErr.Err) {
		t.Fatalf("rollback error %v does not preserve the underlying Stat error", err)
	}
}

func TestPublicationRollbackSurvivesStageSourceRemoval(t *testing.T) {
	outputDir := t.TempDir()
	stageDir, err := createDownloadStage(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(stageDir, "video.mp4")
	if err := os.WriteFile(source, []byte("completed media"), 0o600); err != nil {
		t.Fatal(err)
	}

	published, receipt, err := publishDownloadArtifactsWithReceipt(outputDir, stageDir, "video", []string{source})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if err := rollbackStoragePublication(receipt, nil); err != nil {
		t.Fatalf("rollback published output: %v", err)
	}
	if _, err := os.Lstat(published[0]); !os.IsNotExist(err) {
		t.Fatalf("published output remains after rollback: lstat err=%v", err)
	}
}

func TestPublicationRollbackPreservesForeignReplacement(t *testing.T) {
	outputDir := t.TempDir()
	stageDir, err := createDownloadStage(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(stageDir, "video.mp4")
	if err := os.WriteFile(source, []byte("completed media"), 0o600); err != nil {
		t.Fatal(err)
	}
	published, receipt, err := publishDownloadArtifactsWithReceipt(outputDir, stageDir, "video", []string{source})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(published[0]); err != nil {
		t.Fatal(err)
	}
	foreign := []byte("foreign replacement sentinel")
	if err := os.WriteFile(published[0], foreign, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rollbackStoragePublication(receipt, nil); err == nil {
		t.Fatal("rollback unexpectedly accepted a target no longer owned by this publication")
	}
	got, err := os.ReadFile(published[0])
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(foreign) {
		t.Fatalf("foreign replacement changed: got %q", got)
	}
}

func TestPublicationRejectsNestedReparseParent(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows junction behavior")
	}
	root := t.TempDir()
	outputDir := filepath.Join(root, "output")
	outsideDir := filepath.Join(root, "outside")
	stageDir := filepath.Join(root, "stage")
	for _, dir := range []string{outputDir, outsideDir, filepath.Join(stageDir, "redirect")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	junction := filepath.Join(outputDir, "redirect")
	createStorageTestJunction(t, junction, outsideDir)
	source := filepath.Join(stageDir, "redirect", "escaped.mp4")
	if err := os.WriteFile(source, []byte("staged media"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := publishDownloadArtifacts(outputDir, stageDir, "video", []string{source})
	if err == nil {
		t.Fatal("publication through a nested junction unexpectedly succeeded")
	}
	if _, statErr := os.Lstat(filepath.Join(outsideDir, "escaped.mp4")); !os.IsNotExist(statErr) {
		t.Fatalf("outside output was created or could not be inspected: lstat err=%v", statErr)
	}
}

func TestPublicationAllowsOrdinaryNestedParent(t *testing.T) {
	outputDir := t.TempDir()
	stageDir := filepath.Join(t.TempDir(), "stage")
	if err := os.MkdirAll(filepath.Join(stageDir, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(stageDir, "nested", "video.mp4")
	if err := os.WriteFile(source, []byte("nested media"), 0o600); err != nil {
		t.Fatal(err)
	}
	paths, err := publishDownloadArtifacts(outputDir, stageDir, "video", []string{source})
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || filepath.Dir(paths[0]) != filepath.Join(outputDir, "nested") {
		t.Fatalf("unexpected published paths: %v", paths)
	}
}

func TestPublicationAllowsSelectedOutputRootJunction(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows junction behavior")
	}
	root := t.TempDir()
	target := filepath.Join(root, "selected-target")
	outputDir := filepath.Join(root, "selected-output")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	createStorageTestJunction(t, outputDir, target)
	stageDir, err := createDownloadStage(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(stageDir, "video.mp4")
	if err := os.WriteFile(source, []byte("selected root media"), 0o600); err != nil {
		t.Fatal(err)
	}
	paths, err := publishDownloadArtifacts(outputDir, stageDir, "video", []string{source})
	if err != nil {
		t.Fatalf("selected output root junction rejected: %v", err)
	}
	if len(paths) != 1 || !filepath.IsAbs(paths[0]) {
		t.Fatalf("unexpected published paths: %v", paths)
	}
	if got, err := os.ReadFile(filepath.Join(target, "video.mp4")); err != nil || string(got) != "selected root media" {
		t.Fatalf("selected output file missing or changed: got=%q err=%v", got, err)
	}
}

func createStorageTestJunction(t *testing.T, link, target string) {
	t.Helper()
	output, err := exec.Command("cmd.exe", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Skipf("cannot create test junction: %v (%s)", err, output)
	}
}
