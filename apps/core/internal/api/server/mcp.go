package server

import (
	"net/http"

	"caorushizi.cn/mediago/internal/api/dto"
	"caorushizi.cn/mediago/internal/api/handler"
	"caorushizi.cn/mediago/internal/discovery"
	"caorushizi.cn/mediago/internal/service"
	"github.com/gin-gonic/gin"
)

// DownloadService returns the persistence-backed download service shared by
// the HTTP API and MCP server. It is nil when Core runs without a database.
func (s *Server) DownloadService() *service.DownloadTaskService {
	return s.downloadService
}

// DiscoveryService returns the shared discovery service used by HTTP, MCP,
// CLI-facing routes, and the Electron bridge.
func (s *Server) DiscoveryService() *discovery.Service {
	return s.discoveryService
}

// DiscoveryDownloads returns the shared credential-safe handoff used by HTTP
// and MCP discovery download requests.
func (s *Server) DiscoveryDownloads() *handler.DiscoveryHandler {
	return s.discoveryHandler
}

// RegisterMCPRoutes mounts MCP on the main HTTP server and exposes its status.
// It must be called before Run.
func (s *Server) RegisterMCPRoutes(handler http.Handler, provider func() any) {
	s.engine.Any("/mcp", gin.WrapH(handler))
	s.engine.GET("/api/mcp/status", func(c *gin.Context) {
		c.JSON(http.StatusOK, dto.SuccessResponse{
			Success: true,
			Code:    http.StatusOK,
			Message: "OK",
			Data:    provider(),
		})
	})
}
