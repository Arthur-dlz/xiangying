//go:build !windows

package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mediagocore "caorushizi.cn/mediago/internal/core"
)

func TestPTYRunnerGracefulCancellationLetsProcessFinalize(t *testing.T) {
	tempDir := t.TempDir()
	marker := filepath.Join(tempDir, "finalized")
	script := filepath.Join(tempDir, "live-recorder.sh")
	contents := "#!/bin/sh\ntrap 'printf finalized > \"$1\"; exit 0' INT\nprintf 'started\\n'\nwhile true; do sleep 0.05; done\n"
	if err := os.WriteFile(script, []byte(contents), 0o700); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner := NewPTYRunner()
	err := runner.RunWithOptions(ctx, script, []string{marker}, func(line string) {
		if strings.Contains(line, "started") {
			cancel()
		}
	}, mediagocore.RunnerOptions{
		ShouldGracefullyStop: func() bool { return true },
		GracePeriod:          2 * time.Second,
	})

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("RunWithOptions() error = %v, want context.Canceled", err)
	}
	data, readErr := os.ReadFile(marker)
	if readErr != nil {
		t.Fatalf("graceful stop did not create finalization marker: %v", readErr)
	}
	if string(data) != "finalized" {
		t.Fatalf("finalization marker = %q", data)
	}
}
