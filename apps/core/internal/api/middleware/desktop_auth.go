package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// DesktopAuthMiddleware requires the Electron process credential for every
// route except health and the independently authenticated discovery bridge.
// An empty token disables this middleware for non-desktop server launches.
func DesktopAuthMiddleware(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if token == "" || c.Request.URL.Path == "/healthy" ||
			strings.HasPrefix(c.Request.URL.Path, "/api/bridge/") {
			c.Next()
			return
		}

		authorization := c.GetHeader("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		provided := strings.TrimPrefix(authorization, "Bearer ")
		if len(provided) != len(token) || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	}
}
