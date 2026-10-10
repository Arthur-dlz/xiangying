package i18n

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMiddlewarePrefersAcceptLanguageOverConfig(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(Middleware(func() string { return "en" }))
	engine.GET("/", func(c *gin.Context) {
		c.String(http.StatusOK, Lang(c))
	})

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Accept-Language", "it-IT,it;q=0.9")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	if got, want := response.Body.String(), "it"; got != want {
		t.Fatalf("resolved language = %q, want %q", got, want)
	}
}

func TestMiddlewareNormalizesSystemConfigToFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(Middleware(func() string { return "system" }))
	engine.GET("/", func(c *gin.Context) {
		c.String(http.StatusOK, Lang(c))
	})

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	if got, want := response.Body.String(), DefaultLang; got != want {
		t.Fatalf("resolved language = %q, want %q", got, want)
	}
}
