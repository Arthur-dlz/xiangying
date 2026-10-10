package repo

import (
	"path/filepath"
	"testing"

	"caorushizi.cn/mediago/internal/db"
)

func TestRecoverInterruptedDownloadsOnlyChangesPersistedActiveRows(t *testing.T) {
	database, err := db.New(filepath.Join(t.TempDir(), "downloads.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("database.Close() error = %v", err)
		}
	})
	repository := NewVideoRepository(database)

	statuses := []string{"pending", "downloading", "success", "failed", "stopped"}
	ids := make(map[string]int64, len(statuses))
	for _, status := range statuses {
		video, err := repository.Create(&db.Video{
			Name:          "recovery-" + status,
			Type:          "direct",
			URL:           "https://example.com/" + status,
			Status:        status,
			OutputPath:    "preserve/" + status + ".mp4",
			LastErrorCode: "previous-" + status,
		})
		if err != nil {
			t.Fatalf("create %s row: %v", status, err)
		}
		ids[status] = video.ID
	}

	changed, err := repository.RecoverInterruptedDownloads()
	if err != nil {
		t.Fatalf("RecoverInterruptedDownloads() error = %v", err)
	}
	if changed != 2 {
		t.Fatalf("RecoverInterruptedDownloads() changed %d rows, want 2", changed)
	}

	for _, originalStatus := range statuses {
		video, err := repository.FindByIDOrFail(ids[originalStatus])
		if err != nil {
			t.Fatalf("read %s row: %v", originalStatus, err)
		}
		wantStatus, wantErrorCode := originalStatus, "previous-"+originalStatus
		if originalStatus == "pending" || originalStatus == "downloading" {
			wantStatus, wantErrorCode = "stopped", "download_interrupted"
		}
		if video.Status != wantStatus || video.LastErrorCode != wantErrorCode {
			t.Errorf("%s row after recovery = status %q error %q; want %q / %q", originalStatus, video.Status, video.LastErrorCode, wantStatus, wantErrorCode)
		}
		if video.OutputPath != "preserve/"+originalStatus+".mp4" {
			t.Errorf("%s output path = %q, want preserved path", originalStatus, video.OutputPath)
		}
	}
}
