package outputpolicy

import (
	"errors"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRequireNTFSWithFakeResolver(t *testing.T) {
	tests := []struct {
		name       string
		filesystem string
		resolveErr error
		wantErr    error
	}{
		{name: "ntfs", filesystem: "NTFS"},
		{name: "ntfs case insensitive", filesystem: "nTfS"},
		{name: "exfat", filesystem: "exFAT", wantErr: ErrUnsupportedFilesystem},
		{name: "refs", filesystem: "ReFS", wantErr: ErrUnsupportedFilesystem},
		{name: "fat32", filesystem: "FAT32", wantErr: ErrUnsupportedFilesystem},
		{name: "unknown", filesystem: "Unknown", wantErr: ErrFilesystemCheckFailed},
		{name: "empty", filesystem: "", wantErr: ErrFilesystemCheckFailed},
		{name: "resolver failure", resolveErr: errors.New("probe denied"), wantErr: ErrFilesystemCheckFailed},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			const target = `C:\fixture\missing\output`
			calls := 0
			err := requireNTFS(target, func(path string) (string, error) {
				calls++
				if path != target {
					t.Fatalf("resolver path = %q, want %q", path, target)
				}
				return tt.filesystem, tt.resolveErr
			})
			if calls != 1 {
				t.Fatalf("resolver calls = %d, want 1", calls)
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("requireNTFS() error = %v, want errors.Is(_, %v)", err, tt.wantErr)
			}
		})
	}
}

func TestRequireNTFSRejectsEmptyPathWithoutResolving(t *testing.T) {
	called := false
	err := requireNTFS("  ", func(string) (string, error) {
		called = true
		return "NTFS", nil
	})
	if !errors.Is(err, ErrFilesystemCheckFailed) || called {
		t.Fatalf("requireNTFS() = %v, resolver called = %v; want fail-closed without resolving", err, called)
	}
}

func TestRequireNTFSOutputDirPreservesNonWindowsBehavior(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("non-Windows compatibility path")
	}
	if err := RequireNTFSOutputDir(filepath.Join(t.TempDir(), "not-created")); err != nil {
		t.Fatalf("non-Windows output policy returned error: %v", err)
	}
}
