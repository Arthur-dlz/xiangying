package service

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"caorushizi.cn/mediago/internal/db"
	"caorushizi.cn/mediago/internal/db/repo"
)

type recordingFavoriteIconResolver struct {
	result FaviconResolution
	urls   []string
}

func (r *recordingFavoriteIconResolver) Resolve(_ context.Context, originalURL string) FaviconResolution {
	r.urls = append(r.urls, originalURL)
	return r.result
}

func TestResolveFavoriteIconUsesStoredOriginalURLAndPersistsResult(t *testing.T) {
	database, repository := newFavoriteServiceTestRepository(t)
	iconResolver := &recordingFavoriteIconResolver{result: FaviconResolution{
		Icon:   "https://www.youtube.com/s/desktop/favicon.ico",
		Status: db.FavoriteIconStatusReady,
	}}
	svc := NewFavoriteServiceWithIconResolver(repository, iconResolver)
	favorite, err := repository.Create(&db.Favorite{
		Title:      "YouTube",
		URL:        "https://youtube.com/watch?v=original",
		IconStatus: db.FavoriteIconStatusUnresolved,
	})
	if err != nil {
		t.Fatal(err)
	}

	resolved, err := svc.ResolveFavoriteIcon(context.Background(), favorite.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(iconResolver.urls) != 1 || iconResolver.urls[0] != favorite.URL {
		t.Fatalf("resolver URLs = %#v", iconResolver.urls)
	}
	if resolved.Icon == nil || *resolved.Icon != iconResolver.result.Icon || resolved.IconStatus != db.FavoriteIconStatusReady {
		t.Fatalf("resolved favorite = %+v", resolved)
	}

	persisted, err := repository.FindByID(favorite.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted == nil || persisted.Icon == nil || *persisted.Icon != iconResolver.result.Icon || persisted.IconStatus != db.FavoriteIconStatusReady {
		t.Fatalf("persisted favorite = %+v", persisted)
	}
	_ = database
}

func TestResolveFavoriteIconSkipsReadyAndMissingFavorites(t *testing.T) {
	_, repository := newFavoriteServiceTestRepository(t)
	iconResolver := &recordingFavoriteIconResolver{result: FaviconResolution{Status: db.FavoriteIconStatusRetryable}}
	svc := NewFavoriteServiceWithIconResolver(repository, iconResolver)

	icon := "https://example.com/favicon.ico"
	for _, favorite := range []*db.Favorite{
		{Title: "ready", URL: "https://ready.example", Icon: &icon, IconStatus: db.FavoriteIconStatusReady},
		{Title: "missing", URL: "https://missing.example", IconStatus: db.FavoriteIconStatusMissing},
	} {
		created, err := repository.Create(favorite)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := svc.ResolveFavoriteIcon(context.Background(), created.ID); err != nil {
			t.Fatal(err)
		}
	}

	if len(iconResolver.urls) != 0 {
		t.Fatalf("resolver unexpectedly called with %#v", iconResolver.urls)
	}
}

func TestResolveFavoriteIconRetriesRetryableFavorite(t *testing.T) {
	_, repository := newFavoriteServiceTestRepository(t)
	iconResolver := &recordingFavoriteIconResolver{result: FaviconResolution{Status: db.FavoriteIconStatusRetryable}}
	svc := NewFavoriteServiceWithIconResolver(repository, iconResolver)
	favorite, err := repository.Create(&db.Favorite{
		Title:      "retry",
		URL:        "https://retry.example",
		IconStatus: db.FavoriteIconStatusRetryable,
	})
	if err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if _, err := svc.ResolveFavoriteIcon(context.Background(), favorite.ID); err != nil {
			t.Fatal(err)
		}
	}
	if len(iconResolver.urls) != 2 {
		t.Fatalf("resolver calls = %d, want 2", len(iconResolver.urls))
	}
}

func TestResolveFavoriteIconReturnsNotFound(t *testing.T) {
	_, repository := newFavoriteServiceTestRepository(t)
	svc := NewFavoriteServiceWithIconResolver(repository, &recordingFavoriteIconResolver{})

	_, err := svc.ResolveFavoriteIcon(context.Background(), 999)
	if !errors.Is(err, ErrFavoriteNotFound) {
		t.Fatalf("error = %v, want ErrFavoriteNotFound", err)
	}
}

func newFavoriteServiceTestRepository(t *testing.T) (*db.Database, *repo.FavoriteRepository) {
	t.Helper()
	database, err := db.New(filepath.Join(t.TempDir(), "favorites.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("database.Close() error = %v", err)
		}
	})
	return database, repo.NewFavoriteRepository(database)
}
