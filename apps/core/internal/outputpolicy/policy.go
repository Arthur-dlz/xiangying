// Package outputpolicy enforces the filesystem contract for generated media.
package outputpolicy

import (
	"errors"
	"fmt"
	"strings"
)

var (
	ErrUnsupportedFilesystem = errors.New("unsupported output filesystem; NTFS is required")
	ErrFilesystemCheckFailed = errors.New("cannot verify output filesystem; NTFS is required")
)

type filesystemResolver func(path string) (string, error)

func requireNTFS(path string, resolve filesystemResolver) error {
	if strings.TrimSpace(path) == "" || resolve == nil {
		return ErrFilesystemCheckFailed
	}

	filesystem, err := resolve(path)
	if err != nil {
		return ErrFilesystemCheckFailed
	}
	filesystem = strings.TrimSpace(filesystem)
	if filesystem == "" || strings.EqualFold(filesystem, "unknown") {
		return ErrFilesystemCheckFailed
	}
	if strings.EqualFold(filesystem, "NTFS") {
		return nil
	}
	return fmt.Errorf("%w: %s", ErrUnsupportedFilesystem, filesystem)
}
