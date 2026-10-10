package core

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type blockingDownloader struct {
	started  chan TaskID
	finished chan TaskID
	mu       sync.Mutex
	counts   map[TaskID]int
}

type downloaderFunc func(context.Context, DownloadParams, Callbacks) (DownloadResult, error)

func (f downloaderFunc) Download(ctx context.Context, params DownloadParams, callbacks Callbacks) (DownloadResult, error) {
	return f(ctx, params, callbacks)
}

func (downloaderFunc) Config() interface{} {
	return nil
}

func newBlockingDownloader() *blockingDownloader {
	return &blockingDownloader{
		started:  make(chan TaskID, 20),
		finished: make(chan TaskID, 20),
		counts:   make(map[TaskID]int),
	}
}

func (d *blockingDownloader) Download(ctx context.Context, p DownloadParams, _ Callbacks) (DownloadResult, error) {
	d.mu.Lock()
	d.counts[p.ID]++
	d.mu.Unlock()
	d.started <- p.ID
	<-ctx.Done()
	d.finished <- p.ID
	return DownloadResult{}, ctx.Err()
}

func (d *blockingDownloader) Config() interface{} {
	return nil
}

func (d *blockingDownloader) count(id TaskID) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.counts[id]
}

func TestTaskQueueEnqueueIsIdempotentForActiveTask(t *testing.T) {
	downloader := newBlockingDownloader()
	queue := NewTaskQueue(downloader, 1)
	params := DownloadParams{ID: "1", Type: TypeM3U8, URL: "https://example.com/1.m3u8"}

	if status := queue.Enqueue(params); status != StatusDownloading {
		t.Fatalf("first Enqueue() = %s, want %s", status, StatusDownloading)
	}
	waitForStarted(t, downloader.started, "1")
	if task, ok := queue.GetTask("1"); !ok || task.StartedAt == nil {
		t.Fatalf("active task start time = %#v, exists = %v", task, ok)
	}

	if status := queue.Enqueue(params); status != StatusDownloading {
		t.Fatalf("duplicate Enqueue() = %s, want %s", status, StatusDownloading)
	}
	time.Sleep(20 * time.Millisecond)
	if got := downloader.count("1"); got != 1 {
		t.Fatalf("Download() call count = %d, want 1", got)
	}

	queue.Remove("1")
	waitForStarted(t, downloader.finished, "1")
}

func TestTaskQueueEnqueueIsIdempotentForPendingTask(t *testing.T) {
	downloader := newBlockingDownloader()
	queue := NewTaskQueue(downloader, 1)
	first := DownloadParams{ID: "1", Type: TypeM3U8}
	second := DownloadParams{ID: "2", Type: TypeM3U8}

	queue.Enqueue(first)
	waitForStarted(t, downloader.started, "1")
	if status := queue.Enqueue(second); status != StatusPending {
		t.Fatalf("second Enqueue() = %s, want %s", status, StatusPending)
	}
	if task, ok := queue.GetTask("2"); !ok || task.StartedAt != nil {
		t.Fatalf("pending task start time = %#v, exists = %v", task, ok)
	}
	if status := queue.Enqueue(second); status != StatusPending {
		t.Fatalf("duplicate pending Enqueue() = %s, want %s", status, StatusPending)
	}

	queue.Remove("1")
	waitForStarted(t, downloader.finished, "1")
	waitForStarted(t, downloader.started, "2")
	if task, ok := queue.GetTask("2"); !ok || task.StartedAt == nil {
		t.Fatalf("started queued task start time = %#v, exists = %v", task, ok)
	}
	if got := downloader.count("2"); got != 1 {
		t.Fatalf("Download() call count = %d, want 1", got)
	}
	queue.Remove("2")
	waitForStarted(t, downloader.finished, "2")
}

func TestTaskQueueKeepsTaskActiveUntilTerminalCallbackFinishes(t *testing.T) {
	downloadCalls := make(chan TaskID, 2)
	callbackStarted := make(chan struct{})
	releaseCallback := make(chan struct{})
	queue := NewTaskQueue(downloaderFunc(func(_ context.Context, params DownloadParams, _ Callbacks) (DownloadResult, error) {
		downloadCalls <- params.ID
		return DownloadResult{PrimaryPath: "/downloads/first.mp4"}, nil
	}), 1)
	queue.OnSuccess(func(_ TaskID, result DownloadResult) {
		if result.PrimaryPath != "/downloads/first.mp4" {
			t.Errorf("success output path = %q", result.PrimaryPath)
		}
		close(callbackStarted)
		<-releaseCallback
	})
	params := DownloadParams{ID: "1", Type: TypeM3U8}

	queue.Enqueue(params)
	select {
	case <-callbackStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for success callback")
	}
	if status := queue.Enqueue(params); status != StatusDownloading {
		t.Fatalf("Enqueue() during success callback = %s, want %s", status, StatusDownloading)
	}
	if len(downloadCalls) != 1 {
		t.Fatalf("Download() call count = %d, want 1", len(downloadCalls))
	}
	close(releaseCallback)
}

func TestTaskQueueStopRemovesPendingTask(t *testing.T) {
	downloader := newBlockingDownloader()
	queue := NewTaskQueue(downloader, 1)
	stopped := make(chan TaskID, 1)
	queue.OnStopped(func(id TaskID) { stopped <- id })

	queue.Enqueue(DownloadParams{ID: "1", Type: TypeM3U8})
	waitForStarted(t, downloader.started, "1")
	if status := queue.Enqueue(DownloadParams{ID: "2", Type: TypeM3U8}); status != StatusPending {
		t.Fatalf("second Enqueue() = %s, want %s", status, StatusPending)
	}

	if err := queue.Stop("2"); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	waitForStarted(t, stopped, "2")
	if task, ok := queue.GetTask("2"); !ok || task.Status != StatusStopped {
		t.Fatalf("stopped task = %#v, exists = %v", task, ok)
	}

	queue.Remove("1")
	waitForStarted(t, downloader.finished, "1")
	time.Sleep(20 * time.Millisecond)
	if got := downloader.count("2"); got != 0 {
		t.Fatalf("pending task Download() call count = %d, want 0", got)
	}
}

func TestTaskQueueTreatsFinalizedLiveStopAsSuccess(t *testing.T) {
	started := make(chan struct{})
	queue := NewTaskQueue(downloaderFunc(func(ctx context.Context, params DownloadParams, callbacks Callbacks) (DownloadResult, error) {
		callbacks.OnProgress(ProgressEvent{ID: params.ID, Type: "ready", IsLive: true})
		callbacks.OnProgress(ProgressEvent{ID: params.ID, Type: "progress", IsLive: false})
		close(started)
		<-ctx.Done()
		return DownloadResult{
			PrimaryPath:        "/downloads/live.mp4",
			ArtifactPaths:      []string{"/downloads/live.mp4"},
			FinalizedAfterStop: true,
		}, nil
	}), 1)
	succeeded := make(chan DownloadResult, 1)
	stopped := make(chan TaskID, 1)
	messages := make(chan MessageEvent, 1)
	queue.OnSuccess(func(_ TaskID, result DownloadResult) { succeeded <- result })
	queue.OnStopped(func(id TaskID) { stopped <- id })
	queue.OnMessage(func(message MessageEvent) { messages <- message })

	queue.Enqueue(DownloadParams{ID: "live", Type: TypeM3U8})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for live task")
	}
	if err := queue.Stop("live"); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	select {
	case message := <-messages:
		if message.Message != "Ending live recording and finalizing media" {
			t.Fatalf("live stop message = %q", message.Message)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for live finalization message")
	}

	select {
	case result := <-succeeded:
		if result.PrimaryPath != "/downloads/live.mp4" {
			t.Fatalf("success result = %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for finalized live success")
	}
	select {
	case id := <-stopped:
		t.Fatalf("finalized live task emitted stopped for %s", id)
	case <-time.After(20 * time.Millisecond):
	}
	if task, ok := queue.GetTask("live"); !ok || task.Status != StatusSuccess || task.OutputPath != "/downloads/live.mp4" {
		t.Fatalf("finalized live task = %#v, exists = %v", task, ok)
	}
}

func TestTaskQueueRemoveCancelsActiveAndDropsPendingTask(t *testing.T) {
	downloader := newBlockingDownloader()
	queue := NewTaskQueue(downloader, 1)
	stopped := make(chan TaskID, 2)
	queue.OnStopped(func(id TaskID) { stopped <- id })

	queue.Enqueue(DownloadParams{ID: "1", Type: TypeM3U8})
	waitForStarted(t, downloader.started, "1")
	queue.Enqueue(DownloadParams{ID: "2", Type: TypeM3U8})

	queue.Remove("2")
	if _, ok := queue.GetTask("2"); ok {
		t.Fatal("pending task still exists after Remove()")
	}
	queue.Remove("1")
	waitForStarted(t, downloader.finished, "1")
	waitForMissingTask(t, queue, "1")

	select {
	case id := <-stopped:
		t.Fatalf("OnStopped() called for deleted task %s", id)
	case <-time.After(20 * time.Millisecond):
	}
	if got := downloader.count("2"); got != 0 {
		t.Fatalf("deleted pending task Download() call count = %d, want 0", got)
	}
}

func TestTaskQueueSetMaxRunnerFillsEveryAvailableSlot(t *testing.T) {
	downloader := newBlockingDownloader()
	queue := NewTaskQueue(downloader, 1)

	for _, id := range []TaskID{"1", "2", "3"} {
		queue.Enqueue(DownloadParams{ID: id, Type: TypeM3U8})
	}
	waitForStarted(t, downloader.started, "1")

	queue.SetMaxRunner(3)
	started := map[TaskID]bool{"1": true}
	for len(started) < 3 {
		select {
		case id := <-downloader.started:
			started[id] = true
		case <-time.After(time.Second):
			t.Fatalf("started tasks = %v, want 1, 2, and 3", started)
		}
	}

	for _, id := range []TaskID{"1", "2", "3"} {
		queue.Remove(id)
	}
	for range 3 {
		select {
		case <-downloader.finished:
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for removed task to finish")
		}
	}
}

// A task re-added after Remove must not have the stale execution's result
// persisted over the fresh task's record (runID ownership gate).
func TestTaskQueueReAddedTaskNotCorruptedByStaleCompletion(t *testing.T) {
	releaseStale := make(chan struct{})
	started := make(chan int32, 4)
	var calls int32
	completions := make(chan string, 4)
	queue := NewTaskQueue(downloaderFunc(func(_ context.Context, _ DownloadParams, _ Callbacks) (DownloadResult, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			started <- 1
			<-releaseStale // stale run ignores cancellation, simulating slow cleanup
			return DownloadResult{PrimaryPath: "/downloads/stale.mp4"}, nil
		}
		return DownloadResult{PrimaryPath: "/downloads/fresh.mp4"}, nil
	}), 2)
	queue.OnComplete(func(_ TaskID, result DownloadResult) error {
		completions <- result.PrimaryPath
		return nil
	})
	params := DownloadParams{ID: "1", Type: TypeM3U8}

	queue.Enqueue(params)
	waitForCallNumber(t, started, 1)
	queue.Remove("1")

	if status := queue.Enqueue(params); status != StatusPending {
		t.Fatalf("re-add Enqueue() = %s, want %s", status, StatusPending)
	}

	close(releaseStale)
	select {
	case path := <-completions:
		if path != "/downloads/fresh.mp4" {
			t.Fatalf("persisted result = %q, want %q", path, "/downloads/fresh.mp4")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for re-added task completion")
	}
	select {
	case path := <-completions:
		t.Fatalf("unexpected extra completion persisted: %q", path)
	default:
	}
}

// A re-added task must wait for the removed execution to return before its own
// download starts, even when a runner slot is free.
func TestTaskQueueReAddedTaskWaitsForStaleExecution(t *testing.T) {
	releaseStale := make(chan struct{})
	started := make(chan int32, 4)
	var calls int32
	queue := NewTaskQueue(downloaderFunc(func(_ context.Context, _ DownloadParams, _ Callbacks) (DownloadResult, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			started <- 1
			<-releaseStale
			return DownloadResult{}, context.Canceled
		}
		started <- 2
		return DownloadResult{PrimaryPath: "/downloads/fresh.mp4"}, nil
	}), 2)
	params := DownloadParams{ID: "1", Type: TypeM3U8}

	queue.Enqueue(params)
	waitForCallNumber(t, started, 1)
	queue.Remove("1")

	if status := queue.Enqueue(params); status != StatusPending {
		t.Fatalf("re-add Enqueue() = %s, want %s", status, StatusPending)
	}
	time.Sleep(20 * time.Millisecond)
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("Download() call count after re-add = %d, want 1 (no double start)", got)
	}

	close(releaseStale)
	waitForCallNumber(t, started, 2)
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("Download() call count = %d, want 2", got)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if task, ok := queue.GetTask("1"); ok && task.Status == StatusSuccess {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("re-added task did not succeed")
		}
		time.Sleep(time.Millisecond)
	}
}

// Removing a task whose re-added copy is still queued must not swallow a
// subsequent re-add: the stale queue entry is dropped with the task.
func TestTaskQueueRemoveAfterReAddDoesNotLoseTask(t *testing.T) {
	releaseStale := make(chan struct{})
	started := make(chan int32, 4)
	var calls int32
	queue := NewTaskQueue(downloaderFunc(func(_ context.Context, _ DownloadParams, _ Callbacks) (DownloadResult, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			started <- 1
			<-releaseStale
			return DownloadResult{}, context.Canceled
		}
		started <- 2
		return DownloadResult{PrimaryPath: "/downloads/fresh.mp4"}, nil
	}), 1)
	params := DownloadParams{ID: "1", Type: TypeM3U8}

	queue.Enqueue(params)
	waitForCallNumber(t, started, 1)
	queue.Remove("1")
	if status := queue.Enqueue(params); status != StatusPending {
		t.Fatalf("re-add Enqueue() = %s, want %s", status, StatusPending)
	}

	// Delete the persisted task again while the stale execution winds down.
	queue.Remove("1")
	if status := queue.Enqueue(params); status != StatusPending {
		t.Fatalf("second re-add Enqueue() = %s, want %s", status, StatusPending)
	}

	close(releaseStale)
	waitForCallNumber(t, started, 2)
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("Download() call count = %d, want 2 (task must not be lost)", got)
	}
}

func waitForStarted(t *testing.T, ch <-chan TaskID, want TaskID) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("started task = %s, want %s", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for task %s", want)
	}
}

func waitForCallNumber(t *testing.T, ch <-chan int32, want int32) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("download call = %d, want %d", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for download call %d", want)
	}
}

func waitForMissingTask(t *testing.T, queue *TaskQueue, id TaskID) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, ok := queue.GetTask(id); !ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("task %s still exists", id)
}
