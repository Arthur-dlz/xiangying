//go:build windows
// +build windows

package runner

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"syscall"
	"time"

	mediagocore "caorushizi.cn/mediago/internal/core"
	"github.com/UserExistsError/conpty"
)

// runWithPTY uses ConPTY on the Windows platform
func (r *PTYRunner) runWithPTY(ctx context.Context, binPath string, args []string, onStdLine func(string), options mediagocore.RunnerOptions) error {
	// check if ConPTY is available (requires Windows 10 1809+)
	if !conpty.IsConPtyAvailable() {
		// ConPTY not available, fall back to regular pipe
		return r.fallbackToPipe(ctx, binPath, args, onStdLine, options)
	}

	// build the command-line string
	// arguments containing spaces need to be quoted
	cmdLine := buildCommandLine(binPath, args)

	// create ConPTY (80 columns x 24 rows)
	cpty, err := conpty.Start(cmdLine, conpty.ConPtyDimensions(80, 24))
	if err != nil {
		// ConPTY creation failed, fall back to regular pipe
		return r.fallbackToPipe(ctx, binPath, args, onStdLine, options)
	}

	// use defer to ensure ConPTY is always closed
	var closeOnce sync.Once
	closeConPty := func() {
		closeOnce.Do(func() {
			cpty.Close()
		})
	}
	defer closeConPty()

	// read output (ConPty itself implements io.Reader)
	readDone := make(chan error, 1)
	go func() {
		readDone <- r.readPTYOutput(cpty, onStdLine)
	}()

	// create a separate context for Wait to avoid interfering with the main process
	waitCtx, waitCancel := context.WithCancel(context.Background())
	defer waitCancel()

	// wait for the process to complete
	waitDone := make(chan error, 1)
	go func() {
		exitCode, err := cpty.Wait(waitCtx)
		if err != nil {
			waitDone <- err
		} else if exitCode != 0 {
			waitDone <- fmt.Errorf("process exited with code %d", exitCode)
		} else {
			waitDone <- nil
		}
	}()

	// wait for completion or cancellation
	var finalErr error
	select {
	case <-ctx.Done():
		if gracefulStopRequested(options) {
			_, _ = cpty.Write([]byte{3})
			timer := time.NewTimer(gracefulStopPeriod(options))
			select {
			case <-waitDone:
				timer.Stop()
			case <-timer.C:
				waitCancel()
				closeConPty()
			}
		} else {
			waitCancel()
			closeConPty()
		}
		closeConPty()
		<-readDone // wait for reading to complete
		finalErr = ctx.Err()

	case err := <-waitDone:
		// process completed
		closeConPty() // close ConPTY
		<-readDone    // wait for reading to complete
		finalErr = err
	}

	return finalErr
}

// buildCommandLine builds a Windows command-line string using the Windows
// CRT / CommandLineToArgvW escaping rules. syscall.EscapeArg correctly handles
// spaces, embedded quotes, trailing backslashes and empty arguments (the old
// ad-hoc quoting could drop or split arguments).
func buildCommandLine(binPath string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, syscall.EscapeArg(binPath))
	for _, arg := range args {
		parts = append(parts, syscall.EscapeArg(arg))
	}
	return strings.Join(parts, " ")
}
