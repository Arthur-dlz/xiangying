package server

import (
	"context"
	"io/fs"
	"net/http"
	"strings"

	"caorushizi.cn/mediago/assets"
	"caorushizi.cn/mediago/internal/api/dto"
	"caorushizi.cn/mediago/internal/api/handler"
	"caorushizi.cn/mediago/internal/api/middleware"
	"caorushizi.cn/mediago/internal/api/sse"
	"caorushizi.cn/mediago/internal/core"
	"caorushizi.cn/mediago/internal/db"
	"caorushizi.cn/mediago/internal/db/repo"
	"caorushizi.cn/mediago/internal/discovery"
	dockerproxy "caorushizi.cn/mediago/internal/docker"
	"caorushizi.cn/mediago/internal/i18n"
	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/service"
	"caorushizi.cn/mediago/internal/tasklog"
	"caorushizi.cn/mediago/internal/video"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Server wraps the Gin Engine with its business dependencies.
type Server struct {
	queue  *core.TaskQueue
	hub    *sse.Hub
	engine *gin.Engine
	logs   *tasklog.Manager

	// Config-write authorization inputs (CRG-FIX-10-F3 read-only degradation).
	confStore    handler.ConfigStore
	desktopMode  bool
	enableAuth   bool
	loopbackBind bool

	taskHandler            *handler.TaskHandler
	configHandler          *handler.ConfigHandler
	eventHandler           *handler.EventHandler
	healthHandler          *handler.HealthHandler
	authHandler            *handler.AuthHandler
	utilHandler            *handler.UtilHandler
	sourceHandler          *handler.SourceHandler
	discoveryBridgeHandler *handler.DiscoveryBridgeHandler
	discoveryHandler       *handler.DiscoveryHandler
	dockerHandler          *handler.DockerHandler
	discoveryService       *discovery.Service
	discoveryBroker        *discovery.Broker

	// Database persistence handlers (available when database is non-nil)
	downloadHandler   *handler.DownloadHandler
	favoriteHandler   *handler.FavoriteHandler
	conversionHandler *handler.ConversionHandler

	// Download task service (used by queue callbacks to update database state)
	downloadService *service.DownloadTaskService

	// Video player handler (available when video-root is configured)
	videoHandler *video.Handler
}

// Options holds optional configuration for the server.
type Options struct {
	EnableAuth          bool
	FFmpegBin           string
	VideoRoot           string
	EnvPaths            handler.EnvPaths
	ElectronBridgeToken string
	ElectronAPIToken    string
	// Host is the bind host the server listens on. It decides whether config
	// writes are read-only when no authentication is configured (CRG-FIX-10-F3).
	Host string
}

// New creates an HTTP server instance.
func New(queue *core.TaskQueue, logs *tasklog.Manager, database *db.Database, confStore handler.ConfigStore, opts ...Options) *Server {
	var opt Options
	if len(opts) > 0 {
		opt = opts[0]
	}

	engine := gin.New()
	engine.Use(gin.Logger(), gin.Recovery())
	corsMiddleware := cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization", "X-API-Key"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	})
	engine.Use(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/bridge/") {
			c.Next()
			return
		}
		corsMiddleware(c)
	})

	// i18n middleware — resolve language before auth so error messages are translated
	engine.Use(i18n.Middleware(func() string {
		lang, _ := confStore.Get("language").(string)
		return lang
	}))
	if opt.ElectronAPIToken != "" {
		engine.Use(middleware.DesktopAuthMiddleware(opt.ElectronAPIToken))
	}

	// Optional auth middleware
	if opt.EnableAuth && opt.ElectronAPIToken == "" {
		engine.Use(middleware.AuthMiddleware(confStore))
	}

	hub := sse.New()
	sourceInspector := service.NewM3U8Inspector(confStore)
	discoveryBroker := discovery.NewBroker()
	discoveryService := discovery.NewService(discovery.NewStore(discovery.StoreOptions{}), sourceInspector, discoveryBroker)
	discoveryBroker.SetLifecycleHooks(
		func() { _ = discoveryService.DispatchPending(context.Background()) },
		func(id string) { discoveryService.HandleExecutorDisconnect(id) },
	)

	srv := &Server{
		queue:                  queue,
		hub:                    hub,
		engine:                 engine,
		logs:                   logs,
		confStore:              confStore,
		desktopMode:            opt.ElectronAPIToken != "",
		enableAuth:             opt.EnableAuth,
		loopbackBind:           isLoopbackHost(opt.Host),
		taskHandler:            handler.NewTaskHandler(queue, logs),
		configHandler:          handler.NewConfigHandler(confStore, hub),
		eventHandler:           handler.NewEventHandler(hub),
		healthHandler:          handler.NewHealthHandler(),
		authHandler:            handler.NewAuthHandler(confStore),
		utilHandler:            handler.NewUtilHandler(opt.EnvPaths),
		sourceHandler:          handler.NewSourceHandler(sourceInspector),
		discoveryBridgeHandler: handler.NewDiscoveryBridgeHandler(opt.ElectronBridgeToken, discoveryBroker, discoveryService),
		dockerHandler:          handler.NewDockerHandler(dockerproxy.NewClient(confStore), discoveryService),
		discoveryService:       discoveryService,
		discoveryBroker:        discoveryBroker,
	}

	// Initialize persistence-related components when a database is provided
	if database != nil {
		videoRepo := repo.NewVideoRepository(database)
		favoriteRepo := repo.NewFavoriteRepository(database)
		conversionRepo := repo.NewConversionRepository(database)

		downloadSvc := service.NewDownloadTaskService(videoRepo, queue, logs)
		favoriteSvc := service.NewFavoriteService(favoriteRepo)
		converter := service.NewConverter(opt.FFmpegBin)
		conversionSvc := service.NewConversionService(conversionRepo, converter, hub)

		srv.downloadHandler = handler.NewDownloadHandler(downloadSvc, confStore, hub)
		srv.favoriteHandler = handler.NewFavoriteHandler(favoriteSvc)
		srv.conversionHandler = handler.NewConversionHandler(conversionSvc)
		srv.downloadService = downloadSvc

		// Video player service (requires video root directory)
		if opt.VideoRoot != "" {
			videoSvc := video.NewService(videoRepo, opt.VideoRoot, logs)
			srv.videoHandler = video.NewHandler(videoSvc)
		}
	}

	srv.discoveryHandler = handler.NewDiscoveryHandler(discoveryService, srv.downloadService, confStore, hub)

	srv.registerRoutes()
	srv.setupQueueCallbacks()

	// Serve embedded player UI at /player/
	srv.engine.Use(newEmbeddedSPAHandler(embeddedSPAConfig{
		FS:         assets.PlayerFS,
		Root:       "player",
		PathPrefix: "/player",
	}))

	// Electron owns its renderer. Other runtimes serve the embedded main UI.
	if shouldServeMainUI(opt.ElectronBridgeToken) {
		srv.serveEmbeddedMainUI(assets.WebFS)
	}

	return srv
}

func shouldServeMainUI(electronBridgeToken string) bool {
	return strings.TrimSpace(electronBridgeToken) == ""
}

// isLoopbackHost reports whether host binds to the loopback interface only.
// An empty host is treated as loopback because the default config binds to
// 127.0.0.1; only an explicit non-loopback host enables network exposure.
func isLoopbackHost(host string) bool {
	switch strings.TrimSpace(host) {
	case "", "127.0.0.1", "localhost", "::1", "[::1]":
		return true
	default:
		return false
	}
}

// configWritesAllowed reports whether /api/config mutations are permitted.
//
// Read-only degradation (CRG-FIX-10-F3): when the server runs neither in
// desktop mode (no Electron API token) nor with an authenticated session, and
// it is bound to a non-loopback interface, config writes are rejected so an
// exposed deployment cannot be mutated anonymously. Loopback binds are exempt
// (local trust); desktop mode and authenticated requests are always allowed.
func (s *Server) configWritesAllowed() bool {
	if s.desktopMode {
		return true
	}
	if s.enableAuth {
		if key, _ := s.confStore.Get("apiKey").(string); key != "" {
			return true
		}
	}
	return s.loopbackBind
}

// requireConfigWrite is a Gin middleware that aborts config mutations with 403
// when configWritesAllowed reports the deployment is read-only.
func (s *Server) requireConfigWrite(c *gin.Context) {
	if s.configWritesAllowed() {
		c.Next()
		return
	}
	logger.Warn("Rejected config write on read-only deployment",
		zap.String("path", c.Request.URL.Path),
		zap.String("clientIP", c.ClientIP()))
	c.AbortWithStatusJSON(http.StatusForbidden, dto.ErrorResponse{
		Success: false,
		Code:    http.StatusForbidden,
		Message: i18n.T(c, i18n.MsgConfigReadOnly),
	})
}

func (s *Server) serveEmbeddedMainUI(files fs.FS) {
	s.engine.POST("/share", handleWebShareTarget)
	s.engine.NoRoute(newEmbeddedSPAHandler(embeddedSPAConfig{
		FS:         files,
		Root:       "web",
		PathPrefix: "/",
	}))
}

// Run starts the HTTP server on the given address.
func (s *Server) Run(addr string) error {
	return s.engine.Run(addr)
}

// Engine returns the underlying Gin Engine (primarily used for testing).
func (s *Server) Engine() *gin.Engine {
	return s.engine
}

func (s *Server) Close() {
	if s.discoveryService != nil {
		s.discoveryService.Close()
	}
}
