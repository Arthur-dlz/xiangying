package tasklog

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

// errInvalidTaskID reports a task ID that is not safe to use as a file name.
var errInvalidTaskID = errors.New("invalid task id")

// taskIDPattern mirrors the API-level task ID contract. Task IDs are joined
// into a file name, so anything that could act as a path separator (slash,
// backslash) or a parent reference ("..") must be rejected before any
// filesystem use.
var taskIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// Manager handles per-task log persistence.
type Manager struct {
	baseDir string
	mu      sync.Mutex
}

// NewManager creates a new Manager with the given base directory.
func NewManager(baseDir string) *Manager {
	return &Manager{baseDir: baseDir}
}

// Append writes a log line for the specified task, ensuring the log file exists.
func (m *Manager) Append(taskID string, line string) error {
	if m == nil {
		return errors.New("task log manager is nil")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	if err := m.ensureDir(); err != nil {
		return err
	}

	path, err := m.logPath(taskID)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.WriteString(line + "\n"); err != nil {
		return err
	}
	return nil
}

// Reset removes any existing log file for the given task ID.
func (m *Manager) Reset(taskID string) error {
	if m == nil {
		return errors.New("task log manager is nil")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	if err := m.ensureDir(); err != nil {
		return err
	}

	path, err := m.logPath(taskID)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Read returns the full log content for the given task ID.
func (m *Manager) Read(taskID string) (string, error) {
	if m == nil {
		return "", errors.New("task log manager is nil")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	path, err := m.logPath(taskID)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// logPath maps a task ID to its log file path. The ID is validated first so a
// crafted value cannot escape baseDir through path separators or "..".
func (m *Manager) logPath(taskID string) (string, error) {
	if !taskIDPattern.MatchString(taskID) {
		return "", fmt.Errorf("%w: %q", errInvalidTaskID, taskID)
	}
	return filepath.Join(m.baseDir, taskID+".log"), nil
}

func (m *Manager) ensureDir() error {
	return os.MkdirAll(m.baseDir, 0755)
}
