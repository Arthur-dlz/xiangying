package handler

import (
	"context"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"caorushizi.cn/mediago/internal/db"
	"caorushizi.cn/mediago/internal/db/repo"
	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/service"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

type favoriteHandlerIconResolver struct {
	result service.FaviconResolution
	urls   []string
}

func (r *favoriteHandlerIconResolver) Resolve(_ context.Context, originalURL string) service.FaviconResolution {
	r.urls = append(r.urls, originalURL)
	return r.result
}

func TestFavoriteHandlerResolvesIconByStoredFavoriteID(t *testing.T) {
	resolver := &favoriteHandlerIconResolver{result: service.FaviconResolution{
		Icon:   "https://example.com/assets/favicon.ico",
		Status: db.FavoriteIconStatusReady,
	}}
	engine, repository := newFavoriteHandlerTestRouter(t, resolver)
	favorite, err := repository.Create(&db.Favorite{
		Title:      "Example",
		URL:        "https://example.com/original/path",
		IconStatus: db.FavoriteIconStatusUnresolved,
	})
	if err != nil {
		t.Fatal(err)
	}

	response := performRequest(engine, http.MethodPost, "/api/favorites/"+stringID(favorite.ID)+"/icon/resolve", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if len(resolver.urls) != 1 || resolver.urls[0] != favorite.URL {
		t.Fatalf("resolver URLs = %#v", resolver.urls)
	}
	for _, expected := range []string{
		`"icon":"https://example.com/assets/favicon.ico"`,
		`"iconStatus":"ready"`,
		`"url":"https://example.com/original/path"`,
	} {
		if !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("response missing %s: %s", expected, response.Body.String())
		}
	}
}

func TestFavoriteHandlerResolveIconValidatesIDAndNotFound(t *testing.T) {
	engine, _ := newFavoriteHandlerTestRouter(t, &favoriteHandlerIconResolver{})

	invalid := performRequest(engine, http.MethodPost, "/api/favorites/not-a-number/icon/resolve", "")
	assertErrorResponse(t, invalid, http.StatusBadRequest, errorCodeInvalidID)

	notFound := performRequest(engine, http.MethodPost, "/api/favorites/999/icon/resolve", "")
	assertErrorResponse(t, notFound, http.StatusNotFound, errorCodeFavoriteNotFound)
}

func newFavoriteHandlerTestRouter(t *testing.T, resolver service.FavoriteIconResolver) (*gin.Engine, *repo.FavoriteRepository) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	previousLogger, previousSugar := logger.Logger, logger.Sugar
	logger.Logger = zap.NewNop()
	logger.Sugar = logger.Logger.Sugar()
	t.Cleanup(func() {
		logger.Logger = previousLogger
		logger.Sugar = previousSugar
	})

	database, err := db.New(filepath.Join(t.TempDir(), "favorites.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	repository := repo.NewFavoriteRepository(database)
	handler := NewFavoriteHandler(service.NewFavoriteServiceWithIconResolver(repository, resolver))
	engine := gin.New()
	engine.POST("/api/favorites/:id/icon/resolve", handler.ResolveIcon)
	return engine, repository
}

func stringID(id int64) string {
	return strconv.FormatInt(id, 10)
}
