package repo

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"caorushizi.cn/mediago/internal/db"
	"gorm.io/gorm"
)

func TestConversionRepositoryConcurrentStatusWritesAndReads(t *testing.T) {
	const taskCount = 14
	const progressWritesPerTask = 4

	database, err := db.New(filepath.Join(t.TempDir(), "conversion-concurrency.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	repository := NewConversionRepository(database)
	ids := make([]int64, taskCount)
	for i := range ids {
		name := fmt.Sprintf("concurrent-%02d", i+1)
		conversion, createErr := repository.Create(&db.Conversion{
			Name:         &name,
			Path:         "unused-test-input",
			OutputFormat: "mkv",
			Status:       "converting",
		})
		if createErr != nil {
			t.Fatalf("seed task %d: %v", i+1, createErr)
		}
		ids[i] = conversion.ID
	}

	start := make(chan struct{})
	errors := make(chan error, taskCount*(progressWritesPerTask+1)+8)
	var workers sync.WaitGroup
	for _, id := range ids {
		id := id
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			for progress := 1; progress <= progressWritesPerTask; progress++ {
				if updateErr := repository.UpdateStatus(id, "converting", progress, "", nil); updateErr != nil {
					errors <- fmt.Errorf("progress update id=%d progress=%d: %w", id, progress, updateErr)
				}
			}
			if _, readErr := repository.FindByID(id); readErr != nil {
				errors <- fmt.Errorf("point read id=%d: %w", id, readErr)
			}
		}()
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		<-start
		for page := 1; page <= 4; page++ {
			if _, readErr := repository.FindWithPagination(page, 5); readErr != nil {
				errors <- fmt.Errorf("list read page=%d: %w", page, readErr)
			}
		}
	}()
	close(start)
	workers.Wait()
	close(errors)

	var failures []error
	for operationErr := range errors {
		failures = append(failures, operationErr)
	}
	if len(failures) > 0 {
		for _, operationErr := range failures {
			t.Log(operationErr)
		}
		t.Fatalf("real SQLite concurrent operations had %d errors", len(failures))
	}

	for _, id := range ids {
		errMsg := "cancelled by user"
		if updateErr := repository.UpdateStatus(id, "failed", 0, "", &errMsg); updateErr != nil {
			t.Fatalf("stop-like final write id=%d: %v", id, updateErr)
		}
	}
	for _, id := range ids {
		conversion, readErr := repository.FindByID(id)
		if readErr != nil {
			t.Fatalf("read final task id=%d: %v", id, readErr)
		}
		if conversion == nil || conversion.Status != "failed" {
			t.Fatalf("task id=%d final status = %#v, want failed", id, conversion)
		}
	}

	sqlDB, err := database.DB.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("all %d tasks converged to failed; SQLite pool stats after workload: %+v", taskCount, sqlDB.Stats())
}

func TestPinnedSQLiteBusyCommitLeavesConnectionTransactionOpen(t *testing.T) {
	ctx := context.Background()
	database, err := db.New(filepath.Join(t.TempDir(), "sqlite-failed-commit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	repository := NewConversionRepository(database)
	name := "commit-lock-target"
	conversion, err := repository.Create(&db.Conversion{
		Name:         &name,
		Path:         "unused-test-input",
		OutputFormat: "mkv",
		Status:       "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	sqlDB, err := database.DB.DB()
	if err != nil {
		t.Fatal(err)
	}
	var journalMode string
	if err := sqlDB.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "delete" {
		t.Skipf("controlled COMMIT-lock contract requires rollback journal; actual mode is %q", journalMode)
	}

	reader, err := sqlDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	readerTx, err := reader.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer readerTx.Rollback()
	var count int
	if err := readerTx.QueryRowContext(ctx, "SELECT COUNT(*) FROM conversion").Scan(&count); err != nil {
		t.Fatal(err)
	}

	writer, err := sqlDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	var busyTimeout int
	if err := writer.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if busyTimeout != 5000 {
		t.Fatalf("pinned driver busy_timeout = %dms, want default 5000ms", busyTimeout)
	}
	t.Logf("owned database journal_mode=%s, writer busy_timeout=%dms", journalMode, busyTimeout)
	writerTx, err := writer.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writerTx.ExecContext(ctx, "UPDATE conversion SET progress = 1 WHERE id = ?", conversion.ID); err != nil {
		_ = writerTx.Rollback()
		t.Fatal(err)
	}

	commitErr := writerTx.Commit()
	t.Logf("writer COMMIT while dedicated reader transaction is open: %v", commitErr)
	if commitErr == nil || !strings.Contains(strings.ToLower(commitErr.Error()), "locked") {
		_, _ = writer.ExecContext(ctx, "ROLLBACK")
		t.Fatalf("COMMIT error = %v, want pinned SQLite busy/locked error", commitErr)
	}

	_, beginErr := writer.BeginTx(ctx, nil)
	t.Logf("next BEGIN on same reserved writer connection: %v", beginErr)
	if beginErr == nil || !strings.Contains(strings.ToLower(beginErr.Error()), "transaction within a transaction") {
		if beginErr == nil {
			_, _ = writer.ExecContext(ctx, "ROLLBACK")
		}
		_, _ = writer.ExecContext(ctx, "ROLLBACK")
		t.Fatalf("next BEGIN error = %v, want nested-transaction error", beginErr)
	}

	if err := readerTx.Rollback(); err != nil {
		t.Fatalf("release reader transaction: %v", err)
	}
	if _, err := writer.ExecContext(ctx, "ROLLBACK"); err != nil {
		t.Fatalf("clear transaction left by failed commit: %v", err)
	}
}

func TestConversionStatusWriteDoesNotPoisonPoolAfterBusyCommit(t *testing.T) {
	ctx := context.Background()
	database, err := db.New(filepath.Join(t.TempDir(), "conversion-status-busy-commit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	repository := NewConversionRepository(database)
	name := "conversion-status-target"
	conversion, err := repository.Create(&db.Conversion{
		Name:         &name,
		Path:         "unused-test-input",
		OutputFormat: "mkv",
		Status:       "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	sqlDB, err := database.DB.DB()
	if err != nil {
		t.Fatal(err)
	}
	// Keep one reader connection reserved so the only other pool connection is
	// deterministically reused by the follow-up write after the failed commit.
	sqlDB.SetMaxOpenConns(2)
	reader, err := sqlDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	readerTx, err := reader.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer readerTx.Rollback()
	var count int
	if err := readerTx.QueryRowContext(ctx, "SELECT COUNT(*) FROM conversion").Scan(&count); err != nil {
		t.Fatal(err)
	}

	firstErr := repository.UpdateStatus(conversion.ID, "converting", 1, "", nil)
	t.Logf("repository UpdateStatus with real reader transaction held: %v", firstErr)
	if firstErr == nil || !strings.Contains(strings.ToLower(firstErr.Error()), "locked") {
		t.Fatalf("first status update error = %v, want SQLite busy/locked commit", firstErr)
	}

	if err := readerTx.Rollback(); err != nil {
		t.Fatal(err)
	}
	// Keep reader *sql.Conn reserved after unlocking SQLite. That leaves only
	// the writer connection returned by database/sql after Commit's error.
	secondErr := repository.UpdateStatus(conversion.ID, "failed", 0, "", nil)
	t.Logf("repository UpdateStatus after releasing reader lock: %v", secondErr)
	if secondErr != nil {
		t.Fatalf("follow-up status update after releasing reader lock: %v", secondErr)
	}
}

func TestSingleStatementConversionWriteCanRecoverWithoutDefaultTransaction(t *testing.T) {
	ctx := context.Background()
	database, err := db.New(filepath.Join(t.TempDir(), "conversion-status-no-default-tx.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	name := "conversion-status-no-default-tx-target"
	conversion, err := NewConversionRepository(database).Create(&db.Conversion{
		Name:         &name,
		Path:         "unused-test-input",
		OutputFormat: "mkv",
		Status:       "pending",
	})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(2)
	reader, err := sqlDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	readerTx, err := reader.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer readerTx.Rollback()
	var count int
	if err := readerTx.QueryRowContext(ctx, "SELECT COUNT(*) FROM conversion").Scan(&count); err != nil {
		t.Fatal(err)
	}

	// Experiment with the narrow candidate: each conversion write is a single
	// SQL statement, so skip only GORM's surrounding default transaction.
	candidate := &ConversionRepository{db: database.DB.Session(&gorm.Session{SkipDefaultTransaction: true})}
	firstErr := candidate.UpdateStatus(conversion.ID, "converting", 1, "", nil)
	t.Logf("single-statement UpdateStatus with a real reader transaction held: %v", firstErr)
	if firstErr != nil && !strings.Contains(strings.ToLower(firstErr.Error()), "locked") {
		t.Fatalf("candidate status update error = %v, want success or SQLite busy/locked", firstErr)
	}

	if err := readerTx.Rollback(); err != nil {
		t.Fatal(err)
	}
	// Verify the same pool connection can start a normal GORM transaction after
	// the lock is gone; the former candidate update must not leave it poisoned.
	if err := NewConversionRepository(database).UpdateStatus(conversion.ID, "failed", 0, "", nil); err != nil {
		t.Fatalf("follow-up status write after releasing reader lock: %v", err)
	}
}

func TestConversionRepositoryCreateAndDeleteBehaviorIsPreserved(t *testing.T) {
	database, err := db.New(filepath.Join(t.TempDir(), "conversion-create-delete.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	repository := NewConversionRepository(database)
	name := "create-delete-contract"
	created, err := repository.Create(&db.Conversion{
		Name:         &name,
		Path:         "input.mkv",
		OutputFormat: "mp4",
		Quality:      "high",
	})
	if err != nil {
		t.Fatalf("create conversion: %v", err)
	}
	if created.ID <= 0 {
		t.Fatalf("created ID = %d, want assigned positive ID", created.ID)
	}
	if created.Name == nil || *created.Name != name || created.Status != "pending" {
		t.Fatalf("created conversion = %#v, want original name and pending default", created)
	}

	found, err := repository.FindByID(created.ID)
	if err != nil || found == nil || found.OutputFormat != "mp4" || found.Quality != "high" {
		t.Fatalf("find created conversion = %#v, err=%v", found, err)
	}
	if err := repository.Delete(created.ID); err != nil {
		t.Fatalf("delete conversion: %v", err)
	}
	found, err = repository.FindByID(created.ID)
	if err != nil || found != nil {
		t.Fatalf("find after delete = %#v, err=%v; want nil row without error", found, err)
	}
	if err := repository.Delete(created.ID); err != nil {
		t.Fatalf("delete absent conversion = %v, want existing nil-error behavior", err)
	}
}
