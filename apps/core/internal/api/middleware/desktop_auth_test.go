package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestDesktopAuthMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name       string
		path       string
		authorize  string
		token      string
		wantStatus int
	}{
		{name: "missing token rejected", path: "/api/config", token: "secret", wantStatus: http.StatusUnauthorized},
		{name: "wrong token rejected despite permissive CORS", path: "/api/config", authorize: "Bearer wrong", token: "secret", wantStatus: http.StatusUnauthorized},
		{name: "valid bearer accepted", path: "/api/config", authorize: "Bearer secret", token: "secret", wantStatus: http.StatusNoContent},
		{name: "query token is not accepted", path: "/api/events?token=secret", token: "secret", wantStatus: http.StatusUnauthorized},
		{name: "health remains public", path: "/healthy", token: "secret", wantStatus: http.StatusNoContent},
		{name: "bridge remains independently authenticated", path: "/api/bridge/events", token: "secret", wantStatus: http.StatusNoContent},
		{name: "non desktop server remains unchanged", path: "/api/config", wantStatus: http.StatusNoContent},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			engine := gin.New()
			engine.Use(DesktopAuthMiddleware(tt.token))
			engine.Any("/*path", func(c *gin.Context) { c.Status(http.StatusNoContent) })
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			if tt.authorize != "" {
				req.Header.Set("Authorization", tt.authorize)
			}
			res := httptest.NewRecorder()
			engine.ServeHTTP(res, req)
			if res.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", res.Code, tt.wantStatus)
			}
		})
	}
}
