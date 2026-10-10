package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

type pwaAuthConfigStore struct{}

func (pwaAuthConfigStore) Get(key string) any {
	if key == "apiKey" {
		return "configured-key"
	}
	return nil
}

func (pwaAuthConfigStore) Set(string, any) error       { return nil }
func (pwaAuthConfigStore) Update(map[string]any) error { return nil }
func (pwaAuthConfigStore) Store() any                  { return nil }

func TestPwaRootAssetsBypassApiKeyAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)

	paths := []string{
		"/manifest.json",
		"/service-worker.js",
		"/apple-touch-icon.png",
		"/icon-192.png",
		"/icon-512.png",
		"/icon-192-maskable.png",
		"/icon-512-maskable.png",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			engine := gin.New()
			engine.Use(AuthMiddleware(pwaAuthConfigStore{}))
			engine.GET(path, func(c *gin.Context) {
				c.Status(http.StatusNoContent)
			})

			request := httptest.NewRequest(http.MethodGet, path, nil)
			recorder := httptest.NewRecorder()
			engine.ServeHTTP(recorder, request)

			if recorder.Code != http.StatusNoContent {
				t.Fatalf("expected public asset status %d, got %d", http.StatusNoContent, recorder.Code)
			}
		})
	}
}

func TestMCPPathBypassesApiKeyAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(AuthMiddleware(pwaAuthConfigStore{}))
	engine.Any("/mcp", func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})

	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request.Header.Set("Authorization", "Bearer mcp-token")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("MCP route status = %d, want %d", response.Code, http.StatusNoContent)
	}
}
