package core

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func createDownloadStage(outputDir string) (string, error) {
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return "", fmt.Errorf("create download output directory: %w", err)
	}
	stageDir, err := os.MkdirTemp(outputDir, ".mediago-stage-")
	if err != nil {
		return "", fmt.Errorf("create private download stage: %w", err)
	}
	return stageDir, nil
}

// publishDownloadArtifacts publishes a task's completed artifacts without
// replacing any existing path. Each task gets one suffix across all of its
// outputs; Link supplies the atomic no-replace operation on the same volume.
func publishDownloadArtifacts(outputDir, stageDir, downloadName string, artifactPaths []string) ([]string, error) {
	paths, _, err := publishDownloadArtifactsWithReceipt(outputDir, stageDir, downloadName, artifactPaths)
	return paths, err
}

func publishDownloadArtifactsWithReceipt(outputDir, stageDir, downloadName string, artifactPaths []string) ([]string, []storageLink, error) {
	if len(artifactPaths) == 0 {
		return nil, nil, ErrDownloadOutputMissing
	}
	baseName := outputBaseName(downloadName)
	for suffix := 0; ; suffix++ {
		candidateBase := baseName
		if suffix > 0 {
			candidateBase = fmt.Sprintf("%s (%d)", baseName, suffix)
		}
		occupied, err := outputBaseOccupied(outputDir, candidateBase)
		if err != nil {
			return nil, nil, fmt.Errorf("inspect output target: %w", err)
		}
		if occupied {
			continue
		}

		published := make([]storageLink, 0, len(artifactPaths))
		createdDirs := make([]string, 0)
		targets := make(map[string]struct{}, len(artifactPaths))
		conflict := false
		for _, sourcePath := range artifactPaths {
			absoluteStage, stageErr := filepath.Abs(stageDir)
			absoluteSource, sourceErr := filepath.Abs(sourcePath)
			if stageErr != nil || sourceErr != nil {
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("resolve staged output path"), stageErr, sourceErr, rollbackErr)
			}
			relative, relErr := filepath.Rel(absoluteStage, absoluteSource)
			if relErr != nil || !filepath.IsLocal(relative) {
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("refusing to publish output outside its private stage"), rollbackErr)
			}
			sourceInfo, statErr := os.Stat(sourcePath)
			if statErr != nil {
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("inspect staged output: %w", statErr), rollbackErr)
			}
			if !sourceInfo.Mode().IsRegular() || sourceInfo.Size() == 0 {
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("refusing to publish an empty or non-regular output"), rollbackErr)
			}
			// SameFile loads Windows' lazy file ID while the source still exists.
			// The captured FileInfo remains a rollback receipt if the stage is removed.
			if !os.SameFile(sourceInfo, sourceInfo) {
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("cannot capture staged output identity"), rollbackErr)
			}
			for _, prior := range published {
				if os.SameFile(prior.sourceInfo, sourceInfo) {
					rollbackErr := rollbackStoragePublication(published, createdDirs)
					return nil, nil, errors.Join(fmt.Errorf("multiple artifact paths refer to the same staged file"), rollbackErr)
				}
			}

			relative = renamedStorageRelativePath(relative, baseName, candidateBase)
			targetPath := filepath.Join(outputDir, relative)
			if _, duplicate := targets[targetPath]; duplicate {
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("multiple staged outputs map to the same destination %q", targetPath), rollbackErr)
			}
			targets[targetPath] = struct{}{}
			if err := createStorageParents(outputDir, filepath.Dir(targetPath), &createdDirs); err != nil {
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("create output parent directory: %w", err), rollbackErr)
			}
			if err := os.Link(sourcePath, targetPath); err != nil {
				if errors.Is(err, fs.ErrExist) {
					if !storagePathHasTaskStem(relative, candidateBase) {
						rollbackErr := rollbackStoragePublication(published, createdDirs)
						return nil, nil, errors.Join(fmt.Errorf("existing destination %q cannot be safely numbered", targetPath), rollbackErr)
					}
					conflict = true
					break
				}
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("cannot safely publish output without replacing an existing file: %w", err), rollbackErr)
			}
			published = append(published, storageLink{source: sourcePath, target: targetPath, sourceInfo: sourceInfo})
		}
		if conflict {
			if rollbackErr := rollbackStoragePublication(published, createdDirs); rollbackErr != nil {
				return nil, nil, fmt.Errorf("cannot retry output publication after a collision: %w", rollbackErr)
			}
			continue
		}

		paths := make([]string, 0, len(published))
		for _, link := range published {
			absolute, err := filepath.Abs(link.target)
			if err != nil {
				rollbackErr := rollbackStoragePublication(published, createdDirs)
				return nil, nil, errors.Join(fmt.Errorf("resolve published output path: %w", err), rollbackErr)
			}
			paths = append(paths, filepath.Clean(absolute))
		}
		return paths, published, nil
	}
}

func storageDirectoryHasFiles(root string) (bool, error) {
	found := false
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	if errors.Is(err, fs.SkipAll) {
		return true, nil
	}
	return found, err
}

type storageLink struct {
	source     string
	target     string
	sourceInfo os.FileInfo
}

func outputBaseOccupied(outputDir, candidateBase string) (bool, error) {
	entries, err := os.ReadDir(outputDir)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.IsDir() && entry.Name() == candidateBase || hasCompletedMediaExtension(entry.Name()) && isOutputFilename(entry.Name(), candidateBase) {
			return true, nil
		}
	}
	return false, nil
}

func renamedStorageRelativePath(relative, baseName, candidateBase string) string {
	components := strings.Split(relative, string(filepath.Separator))
	if len(components) > 1 && components[0] == baseName {
		components[0] = candidateBase
	} else {
		leaf := len(components) - 1
		if components[leaf] == baseName {
			components[leaf] = candidateBase
		} else if strings.HasPrefix(components[leaf], baseName+".") {
			components[leaf] = candidateBase + strings.TrimPrefix(components[leaf], baseName)
		}
	}
	return filepath.Join(components...)
}

func publicationRollbackLinks(stageDir string, sources, targets []string) ([]storageLink, error) {
	if len(sources) != len(targets) {
		return nil, fmt.Errorf("published source and target counts differ")
	}
	links := make([]storageLink, 0, len(sources))
	for index, source := range sources {
		relative, err := filepath.Rel(stageDir, source)
		if err != nil || !filepath.IsLocal(relative) {
			return nil, fmt.Errorf("resolve staged path for publication rollback")
		}
		info, err := os.Stat(source)
		if err != nil {
			return nil, fmt.Errorf("inspect staged path for publication rollback: %w", err)
		}
		if !os.SameFile(info, info) {
			return nil, fmt.Errorf("capture staged path identity for publication rollback")
		}
		links = append(links, storageLink{source: source, target: targets[index], sourceInfo: info})
	}
	return links, nil
}

func storagePathHasTaskStem(relative, candidateBase string) bool {
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == candidateBase || strings.HasPrefix(component, candidateBase+".") {
			return true
		}
	}
	return false
}

func createStorageParents(outputDir, targetDir string, created *[]string) error {
	relative, err := filepath.Rel(outputDir, targetDir)
	if err != nil || !filepath.IsLocal(relative) && relative != "." {
		return fmt.Errorf("output target escapes download directory")
	}
	current := outputDir
	if relative == "." {
		return nil
	}
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		if err := os.Mkdir(current, 0o755); err != nil {
			if !errors.Is(err, fs.ErrExist) {
				return err
			}
			info, statErr := os.Lstat(current)
			if statErr != nil {
				return statErr
			}
			if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
				return fmt.Errorf("refusing to publish through a reparse or special output parent")
			}
			if !info.IsDir() {
				return fmt.Errorf("output parent is not a directory")
			}
			continue
		}
		*created = append(*created, current)
	}
	return nil
}

func rollbackStoragePublication(published []storageLink, createdDirs []string) error {
	var rollbackErrors []error
	for index := len(published) - 1; index >= 0; index-- {
		link := published[index]
		targetInfo, targetErr := os.Stat(link.target)
		if targetErr != nil {
			if !errors.Is(targetErr, fs.ErrNotExist) {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("inspect published path %q during rollback: %w", link.target, targetErr))
			}
			continue
		}
		if link.sourceInfo != nil && os.SameFile(link.sourceInfo, targetInfo) {
			if err := os.Remove(link.target); err != nil && !errors.Is(err, fs.ErrNotExist) {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("remove published path %q: %w", link.target, err))
			}
		} else {
			rollbackErrors = append(rollbackErrors, fmt.Errorf("published path %q is no longer owned by this task", link.target))
		}
	}
	for index := len(createdDirs) - 1; index >= 0; index-- {
		if err := os.Remove(createdDirs[index]); err != nil && !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, fs.ErrExist) {
			rollbackErrors = append(rollbackErrors, fmt.Errorf("remove created output directory %q: %w", createdDirs[index], err))
		}
	}
	return errors.Join(rollbackErrors...)
}
