//go:build windows

package outputpolicy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRequireNTFSOutputDirOnExistingAndNestedWindowsPaths(t *testing.T) {
	root := t.TempDir()
	for _, target := range []string{
		root,
		filepath.Join(root, "not-created", "nested", "output"),
	} {
		if err := RequireNTFSOutputDir(target); err != nil {
			t.Fatalf("RequireNTFSOutputDir(%q): %v; this Windows test volume must be NTFS", target, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "not-created")); !os.IsNotExist(err) {
		t.Fatalf("filesystem check created nested output path: stat error = %v", err)
	}
}

func TestWindowsFilesystemResolverFailsClosedForDanglingSymlink(t *testing.T) {
	root := t.TempDir()
	link := filepath.Join(root, "dangling")
	if err := os.Symlink(filepath.Join(root, "missing-target"), link); err != nil {
		t.Skipf("symlink creation unavailable in this test environment: %v", err)
	}
	if err := RequireNTFSOutputDir(filepath.Join(link, "nested")); err == nil {
		t.Fatal("RequireNTFSOutputDir() accepted a path under a dangling reparse point")
	}
}
