// Package runner contains the PTY-based command executor (supports progress bars)
package runner

import (
	"context"
	"io"
	"time"

	mediagocore "caorushizi.cn/mediago/internal/core"
)

// PTYRunner is a command executor based on a pseudo-terminal
// It supports capturing output that requires terminal interaction, such as progress bars
type PTYRunner struct{}

// NewPTYRunner creates a new PTY command executor instance
func NewPTYRunner() *PTYRunner {
	return &PTYRunner{}
}

// Run executes a command and reads output via a pseudo-terminal
// This method correctly captures progress bars that use control characters like \r and \b
// Platform-specific implementations are in pty_windows.go and pty_unix.go
func (r *PTYRunner) Run(ctx context.Context, binPath string, args []string, onStdLine func(string)) error {
	return r.RunWithOptions(ctx, binPath, args, onStdLine, mediagocore.RunnerOptions{})
}

// RunWithOptions executes a command and optionally gives a live recording a
// bounded period to finalize after cancellation.
func (r *PTYRunner) RunWithOptions(ctx context.Context, binPath string, args []string, onStdLine func(string), options mediagocore.RunnerOptions) error {
	return r.runWithPTY(ctx, binPath, args, onStdLine, options)
}

// The concrete implementation of runWithPTY is in the platform-specific files:
// - pty_windows.go: Windows ConPTY implementation
// - pty_unix.go: Unix/Linux/Mac PTY implementation

// readPTYOutput reads PTY output and passes raw bytes in chunks
// Raw PTY output (including ANSI escape sequences) is passed directly and handled by the frontend terminal renderer
func (r *PTYRunner) readPTYOutput(reader io.Reader, onStdLine func(string)) error {
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 && onStdLine != nil {
			onStdLine(string(buf[:n]))
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// fallbackToPipe is the fallback strategy when PTY fails
func (r *PTYRunner) fallbackToPipe(ctx context.Context, binPath string, args []string, onStdLine func(string), options mediagocore.RunnerOptions) error {
	// use the existing ExecRunner as the fallback
	runner := NewExecRunner()
	return runner.RunWithOptions(ctx, binPath, args, onStdLine, options)
}

func gracefulStopRequested(options mediagocore.RunnerOptions) bool {
	return options.ShouldGracefullyStop != nil && options.ShouldGracefullyStop()
}

func gracefulStopPeriod(options mediagocore.RunnerOptions) time.Duration {
	if options.GracePeriod > 0 {
		return options.GracePeriod
	}
	return 8 * time.Second
}
