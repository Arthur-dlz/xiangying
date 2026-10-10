package db

import (
	"path/filepath"
	"testing"
)

func TestFavoriteIconStatusMigrationNormalizesLegacyRows(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "favorites.db")
	database, err := New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	icon := "https://example.com/favicon.ico"
	if err := database.DB.Create(&Favorite{Title: "with icon", URL: "https://example.com", Icon: &icon}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.DB.Create(&Favorite{Title: "without icon", URL: "https://empty.example"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.DB.Create(&Favorite{
		Title:      "inconsistent ready row",
		URL:        "https://inconsistent.example",
		IconStatus: FavoriteIconStatusReady,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	database, err = New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })

	var favorites []Favorite
	if err := database.DB.Order("id ASC").Find(&favorites).Error; err != nil {
		t.Fatal(err)
	}
	if len(favorites) != 3 {
		t.Fatalf("favorites = %d, want 3", len(favorites))
	}
	if favorites[0].IconStatus != FavoriteIconStatusReady {
		t.Fatalf("icon row status = %q, want ready", favorites[0].IconStatus)
	}
	if favorites[1].IconStatus != FavoriteIconStatusUnresolved {
		t.Fatalf("empty row status = %q, want unresolved", favorites[1].IconStatus)
	}
	if favorites[2].IconStatus != FavoriteIconStatusUnresolved {
		t.Fatalf("inconsistent row status = %q, want unresolved", favorites[2].IconStatus)
	}
}
