package core

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

var ErrLiveSegmentRecovery = errors.New("live recording segments could not be merged automatically")

type liveSegment struct {
	index int64
	path  string
	size  int64
}

// recoverLiveM3U8Segments rebuilds the top-level MPEG-TS recording when the
// downloader exits before publishing it. Automatic recovery is deliberately
// limited to one continuous, numerically ordered TS track. Multi-track and
// fragmented-MP4 layouts need the downloader's metadata-aware muxer and are
// left untouched instead of risking a corrupt output.
func recoverLiveM3U8Segments(outputDir, downloadName string) (string, error) {
	segmentRoot := filepath.Join(outputDir, outputBaseName(downloadName))
	groups, err := liveTSSegmentGroups(segmentRoot)
	if err != nil {
		return "", err
	}
	if len(groups) == 0 {
		return "", ErrM3U8OutputMissing
	}
	if len(groups) != 1 {
		return "", fmt.Errorf("%w: found %d media tracks", ErrLiveSegmentRecovery, len(groups))
	}

	var segments []liveSegment
	for _, group := range groups {
		segments = group
	}
	if err := validateLiveTSSegments(segments); err != nil {
		return "", err
	}

	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return "", fmt.Errorf("%w: create output directory: %v", ErrLiveSegmentRecovery, err)
	}
	temporary, err := os.CreateTemp(outputDir, ".mediago-live-recovery-*.ts")
	if err != nil {
		return "", fmt.Errorf("%w: create temporary output: %v", ErrLiveSegmentRecovery, err)
	}
	temporaryPath := temporary.Name()
	keepTemporary := false
	defer func() {
		_ = temporary.Close()
		if !keepTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()

	var expectedSize int64
	for _, segment := range segments {
		source, openErr := os.Open(segment.path)
		if openErr != nil {
			return "", fmt.Errorf("%w: open segment: %v", ErrLiveSegmentRecovery, openErr)
		}
		written, copyErr := io.Copy(temporary, source)
		closeErr := source.Close()
		if copyErr != nil {
			return "", fmt.Errorf("%w: copy segment: %v", ErrLiveSegmentRecovery, copyErr)
		}
		if closeErr != nil {
			return "", fmt.Errorf("%w: close segment: %v", ErrLiveSegmentRecovery, closeErr)
		}
		if written != segment.size {
			return "", fmt.Errorf("%w: segment changed during recovery", ErrLiveSegmentRecovery)
		}
		expectedSize += written
	}

	if err := temporary.Sync(); err != nil {
		return "", fmt.Errorf("%w: flush recovered output: %v", ErrLiveSegmentRecovery, err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("%w: close recovered output: %v", ErrLiveSegmentRecovery, err)
	}
	if expectedSize == 0 {
		return "", fmt.Errorf("%w: recovered output is empty", ErrLiveSegmentRecovery)
	}

	outputPath, err := availableRecoveredOutputPath(outputDir, outputBaseName(downloadName))
	if err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, outputPath); err != nil {
		return "", fmt.Errorf("%w: publish recovered output: %v", ErrLiveSegmentRecovery, err)
	}
	keepTemporary = true

	info, err := os.Stat(outputPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() != expectedSize {
		_ = os.Remove(outputPath)
		if err != nil {
			return "", fmt.Errorf("%w: inspect recovered output: %v", ErrLiveSegmentRecovery, err)
		}
		return "", fmt.Errorf("%w: recovered output size mismatch", ErrLiveSegmentRecovery)
	}
	absolute, err := filepath.Abs(outputPath)
	if err != nil {
		return "", fmt.Errorf("%w: resolve recovered output: %v", ErrLiveSegmentRecovery, err)
	}
	return absolute, nil
}

func liveTSSegmentGroups(root string) (map[string][]liveSegment, error) {
	groups := make(map[string][]liveSegment)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || !strings.EqualFold(filepath.Ext(entry.Name()), ".ts") {
			return nil
		}
		index, parseErr := strconv.ParseInt(strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())), 10, 64)
		if parseErr != nil {
			return fmt.Errorf("%w: non-numeric TS segment name", ErrLiveSegmentRecovery)
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return fmt.Errorf("%w: empty or non-regular TS segment", ErrLiveSegmentRecovery)
		}
		directory := filepath.Dir(path)
		groups[directory] = append(groups[directory], liveSegment{index: index, path: path, size: info.Size()})
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return groups, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w: inspect preserved segments: %v", ErrLiveSegmentRecovery, err)
	}
	return groups, nil
}

func validateLiveTSSegments(segments []liveSegment) error {
	if len(segments) == 0 {
		return ErrM3U8OutputMissing
	}
	sort.Slice(segments, func(i, j int) bool { return segments[i].index < segments[j].index })
	for index := 1; index < len(segments); index++ {
		if segments[index].index != segments[index-1].index+1 {
			return fmt.Errorf("%w: TS segment sequence has a gap", ErrLiveSegmentRecovery)
		}
	}
	return nil
}

func availableRecoveredOutputPath(outputDir, baseName string) (string, error) {
	candidates := []string{
		filepath.Join(outputDir, baseName+".ts"),
		filepath.Join(outputDir, baseName+".recovered.ts"),
	}
	for suffix := 2; ; suffix++ {
		for _, candidate := range candidates {
			_, err := os.Lstat(candidate)
			if errors.Is(err, os.ErrNotExist) {
				return candidate, nil
			}
			if err != nil {
				return "", fmt.Errorf("%w: inspect output target: %v", ErrLiveSegmentRecovery, err)
			}
		}
		candidates = []string{filepath.Join(outputDir, fmt.Sprintf("%s.recovered-%d.ts", baseName, suffix))}
	}
}
