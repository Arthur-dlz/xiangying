//go:build windows

package outputpolicy

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// RequireNTFSOutputDir accepts only output directories located on NTFS.
// Missing descendant directories are checked against their nearest existing
// directory ancestor before callers create staging files or invoke tools.
func RequireNTFSOutputDir(path string) error {
	return requireNTFS(path, windowsFilesystemName)
}

func windowsFilesystemName(path string) (string, error) {
	ancestor, err := existingDirectoryAncestor(path)
	if err != nil {
		return "", err
	}

	absolute, err := filepath.Abs(ancestor)
	if err != nil {
		return "", err
	}
	input, err := windows.UTF16PtrFromString(absolute)
	if err != nil {
		return "", err
	}
	volumePath := make([]uint16, 32_768)
	if err := windows.GetVolumePathName(input, &volumePath[0], uint32(len(volumePath))); err != nil {
		return "", err
	}
	volumeRoot, err := windows.UTF16PtrFromString(windows.UTF16ToString(volumePath))
	if err != nil {
		return "", err
	}

	var volumeName [windows.MAX_PATH]uint16
	var filesystemName [windows.MAX_PATH]uint16
	var serialNumber uint32
	var maximumComponentLength uint32
	var flags uint32
	if err := windows.GetVolumeInformation(
		volumeRoot,
		&volumeName[0], uint32(len(volumeName)),
		&serialNumber,
		&maximumComponentLength,
		&flags,
		&filesystemName[0], uint32(len(filesystemName)),
	); err != nil {
		return "", err
	}
	return windows.UTF16ToString(filesystemName[:]), nil
}

func existingDirectoryAncestor(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	current := filepath.Clean(absolute)
	for {
		info, statErr := os.Stat(current)
		if statErr == nil {
			if !info.IsDir() {
				return "", errors.New("output path ancestor is not a directory")
			}
			// Resolve symlinks/junctions so the real target's volume — not the
			// link's host directory — is the one classified. Otherwise a
			// resolvable link to another volume could pass the NTFS check while
			// the actual write target is non-NTFS.
			resolved, linkErr := filepath.EvalSymlinks(current)
			if linkErr != nil {
				return "", linkErr
			}
			return resolved, nil
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return "", statErr
		}

		// Do not walk past a dangling symlink/reparse point and accidentally
		// classify its parent volume as the output volume.
		if _, linkErr := os.Lstat(current); linkErr == nil {
			return "", errors.New("output path contains an unresolved reparse point")
		} else if !errors.Is(linkErr, os.ErrNotExist) {
			return "", linkErr
		}

		parent := filepath.Dir(current)
		if parent == current {
			return "", statErr
		}
		current = parent
	}
}
