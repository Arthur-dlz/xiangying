package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"caorushizi.cn/mediago/internal/api/sse"
	"caorushizi.cn/mediago/internal/db"
	"caorushizi.cn/mediago/internal/db/repo"
	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/service"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func TestConversionGetSeparatesMissingRowsFromStorageErrors(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previousLogger, previousSugar := logger.Logger, logger.Sugar
	logger.Logger = zap.NewNop()
	logger.Sugar = logger.Logger.Sugar()
	t.Cleanup(func() {
		logger.Logger = previousLogger
		logger.Sugar = previousSugar
	})

	t.Run("existing row returns success", func(t *testing.T) {
		database, repository, engine := newConversionGetTestEngine(t)
		name := "present"
		conversion, err := repository.Create(&db.Conversion{Name: &name, Path: "unused-input", Status: "pending"})
		if err != nil {
			t.Fatal(err)
		}

		response := conversionGetRequest(engine, conversion.ID)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		_ = database.Close()
	})

	t.Run("missing row remains not found", func(t *testing.T) {
		_, _, engine := newConversionGetTestEngine(t)
		response := conversionGetRequest(engine, 404)
		assertErrorResponse(t, response, http.StatusNotFound, errorCodeConversionNotFound)
	})

	t.Run("database error is internal and does not leak details", func(t *testing.T) {
		database, repository, engine := newConversionGetTestEngine(t)
		name := "storage-error"
		conversion, err := repository.Create(&db.Conversion{Name: &name, Path: "unused-input", Status: "pending"})
		if err != nil {
			t.Fatal(err)
		}
		if err := database.Close(); err != nil {
			t.Fatal(err)
		}

		response := conversionGetRequest(engine, conversion.ID)
		assertErrorResponse(t, response, http.StatusInternalServerError, errorCodeInternalError)
		if strings.Contains(response.Body.String(), "database is closed") {
			t.Fatalf("storage details leaked in response: %s", response.Body.String())
		}
	})
}

func newConversionGetTestEngine(t *testing.T) (*db.Database, *repo.ConversionRepository, *gin.Engine) {
	t.Helper()
	database, err := db.New(filepath.Join(t.TempDir(), "conversion.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	repository := repo.NewConversionRepository(database)
	conversionService := service.NewConversionService(repository, service.NewConverter(""), sse.New())
	handler := NewConversionHandler(conversionService)
	engine := gin.New()
	engine.GET("/api/conversions/:id", handler.Get)
	return database, repository, engine
}

func conversionGetRequest(engine *gin.Engine, id int64) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/api/conversions/"+stringID(id), nil)
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return response
}
