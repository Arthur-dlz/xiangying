// Package core contains the task queue implementation
package core

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"caorushizi.cn/mediago/internal/logger"
	"go.uber.org/zap"
)

var (
	ErrTaskNotFound = errors.New("task not found")
)

// activeRun tracks one in-flight execution of a task. runID is a monotonically
// increasing generation: it lets an execution recognise whether the queue entry
// under its ID still belongs to it, so a removed (and possibly re-added) task
// cannot be corrupted by a stale execution.
type activeRun struct {
	cancel context.CancelFunc
	runID  uint64
}

// TaskQueue is the task queue, responsible for concurrency control, task scheduling, and event dispatching
type TaskQueue struct {
	downloader Downloader // downloader instance
	maxRunner  int        // maximum concurrency

	mu        sync.RWMutex          // read-write lock
	queue     []DownloadParams      // pending task queue
	active    map[TaskID]*activeRun // active tasks (task ID -> running execution)
	tasks     map[TaskID]*TaskInfo  // task info table (task ID -> task info)
	discarded map[TaskID]uint64     // removed executions (task ID -> generation) whose callbacks should be ignored
	runSeq    uint64                // monotonically increasing execution generation

	// event callback functions
	onStart    func(TaskID)
	onComplete func(TaskID, DownloadResult) error
	onSuccess  func(TaskID, DownloadResult)
	onFailed   func(TaskID, error)
	onStopped  func(TaskID)
	onProgress func(ProgressEvent)
	onMessage  func(MessageEvent)
}

// NewTaskQueue creates a new task queue instance
func NewTaskQueue(d Downloader, maxRunner int) *TaskQueue {
	if maxRunner < 1 {
		maxRunner = 1
	}

	return &TaskQueue{
		downloader: d,
		maxRunner:  maxRunner,
		active:     make(map[TaskID]*activeRun),
		tasks:      make(map[TaskID]*TaskInfo),
		discarded:  make(map[TaskID]uint64),
	}
}

// nextRunLocked returns a fresh execution generation. Callers must hold q.mu.
func (q *TaskQueue) nextRunLocked() uint64 {
	q.runSeq++
	return q.runSeq
}

func (q *TaskQueue) IsFull() bool {
	q.mu.RLock()
	defer q.mu.RUnlock()
	return len(q.active) >= q.maxRunner
}

func (q *TaskQueue) Downloader() Downloader {
	return q.downloader
}

// IsScheduled includes terminal tasks whose completion callbacks are still running.
func (q *TaskQueue) IsScheduled(id TaskID) bool {
	q.mu.RLock()
	defer q.mu.RUnlock()
	// A removed execution no longer blocks a re-add even though its slot stays
	// occupied until execute() returns.
	if _, removed := q.discarded[id]; removed {
		return false
	}
	if _, ok := q.active[id]; ok {
		return true
	}
	for _, pending := range q.queue {
		if pending.ID == id {
			return true
		}
	}
	return false
}

// SetMaxRunner sets the maximum concurrency.
func (q *TaskQueue) SetMaxRunner(n int) {
	if n < 1 {
		n = 1
	}

	q.mu.Lock()
	q.maxRunner = n
	q.mu.Unlock()
	q.tryRun()
}

// Enqueue adds a task to the queue. Repeated requests for the same active or
// pending task are idempotent and return the existing status. A task re-added
// after Remove is queued until the removed execution has fully returned, so a
// task ID never has two downloads running at once.
func (q *TaskQueue) Enqueue(p DownloadParams) TaskStatus {
	q.mu.Lock()

	if _, ok := q.active[p.ID]; ok {
		if _, removed := q.discarded[p.ID]; !removed {
			q.mu.Unlock()
			logger.Info("Ignored duplicate active task", zap.String("id", string(p.ID)))
			return StatusDownloading
		}
		// The active entry belongs to a removed execution that has not returned
		// yet; allow the re-add to start a fresh run instead of dropping it.
	}

	for _, pending := range q.queue {
		if pending.ID == p.ID {
			q.mu.Unlock()
			logger.Info("Ignored duplicate pending task", zap.String("id", string(p.ID)))
			return StatusPending
		}
	}

	// A re-added task supersedes any previous removal marker.
	delete(q.discarded, p.ID)

	q.tasks[p.ID] = &TaskInfo{
		ID:      p.ID,
		Type:    p.Type,
		URL:     p.URL,
		Name:    p.Name,
		Status:  StatusPending,
		Percent: 0,
		Speed:   "",
		IsLive:  false,
	}

	// Never start while a previous execution of the same ID is still winding
	// down: two downloads racing for the same output could corrupt files. The
	// stale run's cleanup re-invokes tryRun, which starts the queued copy.
	if _, stale := q.active[p.ID]; !stale && len(q.active) < q.maxRunner {
		q.tasks[p.ID].Status = StatusDownloading
		runID := q.nextRunLocked()
		q.tasks[p.ID].runID = runID
		ctx, cancel := context.WithCancel(context.Background())
		q.active[p.ID] = &activeRun{cancel: cancel, runID: runID}
		q.mu.Unlock()

		logger.Info("Task started immediately", zap.String("id", string(p.ID)))
		go q.execute(p, ctx, runID)
		return StatusDownloading
	}

	q.queue = append(q.queue, p)
	queueLen := len(q.queue)
	q.mu.Unlock()

	logger.Info("Task enqueued",
		zap.String("id", string(p.ID)),
		zap.Int("queueLength", queueLen))
	return StatusPending
}

// Stop stops an active task or removes a pending task from the queue.
func (q *TaskQueue) Stop(id TaskID) error {
	q.mu.Lock()
	if run, ok := q.active[id]; ok {
		isLive := q.tasks[id] != nil && q.tasks[id].IsLive
		if task := q.tasks[id]; task != nil && task.Status == StatusDownloading {
			task.StopRequested = true
		}
		q.mu.Unlock()
		if isLive {
			logger.Info("Ending live recording", zap.String("id", string(id)))
			if q.onMessage != nil {
				q.onMessage(MessageEvent{ID: id, Message: "Ending live recording and finalizing media"})
			}
		} else {
			logger.Info("Stopping active task", zap.String("id", string(id)))
		}
		run.cancel()
		return nil
	}

	for i, pending := range q.queue {
		if pending.ID != id {
			continue
		}

		q.queue = append(q.queue[:i], q.queue[i+1:]...)
		if task, ok := q.tasks[id]; ok {
			task.Status = StatusStopped
		}
		q.mu.Unlock()

		logger.Info("Removed pending task from queue", zap.String("id", string(id)))
		if q.onStopped != nil {
			q.onStopped(id)
		}
		return nil
	}
	q.mu.Unlock()

	logger.Warn("Attempted to stop non-existent task", zap.String("id", string(id)))
	return ErrTaskNotFound
}

// Remove cancels an active task or removes a pending task without emitting a
// stopped event. It is used when the persisted task itself is being deleted.
func (q *TaskQueue) Remove(id TaskID) {
	q.mu.Lock()
	if run, ok := q.active[id]; ok {
		// Record the generation being removed so a re-added task under the same
		// ID is not clobbered when this execution returns.
		q.discarded[id] = run.runID
		delete(q.tasks, id)
		// Drop a queued re-add of the same ID as well: the persisted task is
		// gone, and a stale queue entry would swallow later re-adds.
		for i, pending := range q.queue {
			if pending.ID == id {
				q.queue = append(q.queue[:i], q.queue[i+1:]...)
				break
			}
		}
		q.mu.Unlock()

		logger.Info("Cancelling deleted active task", zap.String("id", string(id)))
		run.cancel()
		return
	}

	for i, pending := range q.queue {
		if pending.ID == id {
			q.queue = append(q.queue[:i], q.queue[i+1:]...)
			break
		}
	}
	delete(q.tasks, id)
	q.mu.Unlock()
}

// tryRun fills all available runner slots with pending tasks.
func (q *TaskQueue) tryRun() {
	type runnable struct {
		params DownloadParams
		ctx    context.Context
		runID  uint64
	}

	q.mu.Lock()
	runnables := make([]runnable, 0)
	for len(q.active) < q.maxRunner && len(q.queue) > 0 {
		task := q.queue[0]
		if _, running := q.active[task.ID]; running {
			// The queue head still has an active entry — a removed execution
			// that has not returned yet (a re-added task waiting for its ID's
			// slot). Keep it queued; that execution's cleanup re-invokes
			// tryRun once the entry is released.
			break
		}
		q.queue = q.queue[1:]

		info, ok := q.tasks[task.ID]
		if !ok {
			continue
		}

		info.Status = StatusDownloading
		runID := q.nextRunLocked()
		info.runID = runID
		ctx, cancel := context.WithCancel(context.Background())
		q.active[task.ID] = &activeRun{cancel: cancel, runID: runID}
		runnables = append(runnables, runnable{params: task, ctx: ctx, runID: runID})
	}
	q.mu.Unlock()

	for _, task := range runnables {
		logger.Info("Starting queued task", zap.String("id", string(task.params.ID)))
		go q.execute(task.params, task.ctx, task.runID)
	}
}

// execute runs a single download task. runID identifies this execution so the
// task bookkeeping is only mutated while the queue entry still belongs to it.
func (q *TaskQueue) execute(p DownloadParams, ctx context.Context, runID uint64) {
	logger.Info("Executing task",
		zap.String("id", string(p.ID)),
		zap.String("type", string(p.Type)))

	q.mu.Lock()
	runtimeTask, exists := q.tasks[p.ID]
	owned := exists && runtimeTask.runID == runID
	if owned && runtimeTask.StartedAt == nil {
		startedAt := time.Now().UTC()
		runtimeTask.StartedAt = &startedAt
	}
	q.mu.Unlock()
	if owned && q.onStart != nil {
		q.onStart(p.ID)
	}

	result, err := q.downloader.Download(ctx, p, Callbacks{
		OnProgress: func(e ProgressEvent) {
			q.mu.Lock()
			task, exists := q.tasks[p.ID]
			owned := exists && task.runID == runID
			if owned {
				task.Percent = e.Percent
				task.Speed = e.Speed
				task.IsLive = task.IsLive || e.IsLive
			}
			q.mu.Unlock()

			if owned && q.onProgress != nil {
				q.onProgress(e)
			}
		},
		OnMessage: func(m MessageEvent) {
			q.mu.RLock()
			task, exists := q.tasks[p.ID]
			owned := exists && task.runID == runID
			q.mu.RUnlock()
			if owned && q.onMessage != nil {
				q.onMessage(m)
			}
		},
	})

	// Completion persistence must finish before any observer can see success.
	// Never hold q.mu across callbacks: the service also reads the queue.
	// A result may only be persisted while this execution still owns the task
	// entry: after a remove-and-re-add the entry belongs to a newer
	// generation, and persisting a stale execution's result would corrupt the
	// re-added task's record.
	q.mu.RLock()
	entry, entryExists := q.tasks[p.ID]
	ownsEntry := entryExists && entry.runID == runID
	discardedRun, discarded := q.discarded[p.ID]
	q.mu.RUnlock()
	if err == nil && ownsEntry && !(discarded && discardedRun == runID) && q.onComplete != nil {
		if persistErr := q.onComplete(p.ID, result); persistErr != nil {
			err = fmt.Errorf("%w: %v", ErrResultPersistence, persistErr)
		}
	}

	q.mu.Lock()
	current, exists := q.tasks[p.ID]
	if !exists || current.runID != runID {
		// A newer execution owns the entry now (the task was removed and
		// re-added); leave its bookkeeping untouched and drop only our marker.
		if run, ok := q.discarded[p.ID]; ok && run == runID {
			delete(q.discarded, p.ID)
		}
		// Release our own slot so a queued task can take it. A newer run under
		// the same ID keeps its own active entry.
		if run, ok := q.active[p.ID]; ok && run.runID == runID {
			delete(q.active, p.ID)
		}
		q.mu.Unlock()
		q.tryRun()
		return
	}

	if run, ok := q.discarded[p.ID]; ok && run == runID {
		// This execution was removed while it was running.
		delete(q.discarded, p.ID)
		delete(q.active, p.ID)
		delete(q.tasks, p.ID)
		q.mu.Unlock()
		q.tryRun()
		return
	}

	switch {
	case err == nil:
		current.Status = StatusSuccess
		current.Percent = 100
		current.OutputPath = result.PrimaryPath
		current.ArtifactPaths = append([]string(nil), result.ArtifactPaths...)
	case errors.Is(err, context.Canceled):
		current.Status = StatusStopped
	default:
		current.Status = StatusFailed
		current.Error = err.Error()
		failure := DescribeDownloadFailure(err)
		current.Failure = &failure
	}
	q.mu.Unlock()

	switch {
	case err == nil:
		if result.FinalizedAfterStop {
			logger.Info("Live recording stopped and saved", zap.String("id", string(p.ID)))
		} else {
			logger.Info("Task completed successfully", zap.String("id", string(p.ID)))
		}
		if q.onSuccess != nil {
			q.onSuccess(p.ID, result)
		}
	case errors.Is(err, context.Canceled):
		logger.Info("Task was stopped", zap.String("id", string(p.ID)))
		if q.onStopped != nil {
			q.onStopped(p.ID)
		}
	default:
		logger.Error("Task failed",
			zap.String("id", string(p.ID)),
			zap.Error(err))
		if q.onFailed != nil {
			q.onFailed(p.ID, err)
		}
	}

	q.mu.Lock()
	if run, ok := q.discarded[p.ID]; ok && run == runID {
		// Removed during the terminal callback: drop this execution's state.
		delete(q.discarded, p.ID)
		delete(q.tasks, p.ID)
	}
	if run, ok := q.active[p.ID]; ok && run.runID == runID {
		delete(q.active, p.ID)
	}
	q.mu.Unlock()

	q.tryRun()
}

// Event hook registration methods (for use by the API layer)

func (q *TaskQueue) OnStart(fn func(TaskID)) {
	q.onStart = fn
}

func (q *TaskQueue) OnSuccess(fn func(TaskID, DownloadResult)) {
	q.onSuccess = fn
}

// OnComplete registers persistence that must succeed before publishing success.
func (q *TaskQueue) OnComplete(fn func(TaskID, DownloadResult) error) {
	q.onComplete = fn
}

func (q *TaskQueue) OnFailed(fn func(TaskID, error)) {
	q.onFailed = fn
}

func (q *TaskQueue) OnStopped(fn func(TaskID)) {
	q.onStopped = fn
}

func (q *TaskQueue) OnProgress(fn func(ProgressEvent)) {
	q.onProgress = fn
}

func (q *TaskQueue) OnMessage(fn func(MessageEvent)) {
	q.onMessage = fn
}

// GetTask retrieves information about the specified task.
func (q *TaskQueue) GetTask(id TaskID) (*TaskInfo, bool) {
	q.mu.RLock()
	defer q.mu.RUnlock()
	task, ok := q.tasks[id]
	if !ok {
		return nil, false
	}
	// Return a copy to prevent external modification.
	taskCopy := *task
	return &taskCopy, true
}

// GetAllTasks retrieves information about all tasks.
func (q *TaskQueue) GetAllTasks() []TaskInfo {
	q.mu.RLock()
	defer q.mu.RUnlock()

	tasks := make([]TaskInfo, 0, len(q.tasks))
	for _, task := range q.tasks {
		tasks = append(tasks, *task)
	}
	return tasks
}
