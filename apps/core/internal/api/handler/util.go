package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"caorushizi.cn/mediago/internal/api/dto"
	"caorushizi.cn/mediago/internal/i18n"
	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/service"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// EnvPaths holds server environment paths exposed via the API.
type EnvPaths struct {
	ConfigDir string `json:"configDir"`
	BinDir    string `json:"binDir"`
	Platform  string `json:"platform"`
	PlayerUrl string `json:"playerUrl,omitempty"`
}

// UtilHandler handles utility endpoints.
type UtilHandler struct {
	env EnvPaths
}

// NewUtilHandler creates a UtilHandler.
func NewUtilHandler(env EnvPaths) *UtilHandler {
	return &UtilHandler{env: env}
}

// GetEnvPaths returns server environment paths.
// @Summary Get environment paths
// @Tags Util
// @Produce json
// @Success 200 {object} dto.SuccessResponse
// @Router /env [get]
func (h *UtilHandler) GetEnvPaths(c *gin.Context) {
	env := h.env
	// Compute playerUrl dynamically from the request host
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	env.PlayerUrl = fmt.Sprintf("%s://%s/player/", scheme, c.Request.Host)

	c.JSON(http.StatusOK, dto.SuccessResponse{
		Success: true,
		Code:    http.StatusOK,
		Message: i18n.T(c, i18n.MsgOK),
		Data:    env,
	})
}

var titleRegex = regexp.MustCompile(`(?i)<title[^>]*>(.*?)</title>`)

// GetPageTitle fetches a URL and extracts the HTML <title> tag.
// @Summary Get page title
// @Tags Util
// @Produce json
// @Param url query string true "URL to fetch"
// @Success 200 {object} dto.SuccessResponse
// @Router /url/title [get]
func (h *UtilHandler) GetPageTitle(c *gin.Context) {
	url := c.Query("url")
	if url == "" {
		c.JSON(http.StatusBadRequest, dto.ErrorResponse{
			Success: false,
			Code:    http.StatusBadRequest,
			Message: i18n.T(c, i18n.MsgURLRequired),
		})
		return
	}

	title, err := fetchTitle(c.Request.Context(), url)
	if err != nil {
		c.JSON(http.StatusBadGateway, dto.ErrorResponse{
			Success: false,
			Code:    http.StatusBadGateway,
			Message: i18n.T(c, i18n.MsgInternalError),
		})
		return
	}

	c.JSON(http.StatusOK, dto.SuccessResponse{
		Success: true,
		Code:    http.StatusOK,
		Message: i18n.T(c, i18n.MsgOK),
		Data:    map[string]string{"data": title},
	})
}

// fetchTitle fetches rawURL and extracts its HTML <title>. It reports a failure
// instead of returning a fabricated name, so callers can tell a real title from
// a failed fetch. The outbound request is bound to ctx and uses a client that
// refuses non-public destinations (SSRF guard).
func fetchTitle(ctx context.Context, rawURL string) (string, error) {
	client := service.NewPublicHTTPClient(10 * time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		logger.Warn("getPageTitle: failed to create request", zap.String("url", rawURL), zap.Error(err))
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
	req.Header.Set("Referer", rawURL)

	resp, err := client.Do(req)
	if err != nil {
		logger.Warn("getPageTitle: request failed", zap.String("url", rawURL), zap.Error(err))
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		logger.Warn("getPageTitle: unexpected status", zap.String("url", rawURL), zap.Int("status", resp.StatusCode))
		return "", fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	// Read up to 64KB to find the title
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		logger.Warn("getPageTitle: failed to read body", zap.String("url", rawURL), zap.Error(err))
		return "", fmt.Errorf("read body: %w", err)
	}

	matches := titleRegex.FindSubmatch(body)
	if len(matches) >= 2 {
		title := strings.TrimSpace(string(matches[1]))
		if title != "" {
			return title, nil
		}
	}

	return "", errors.New("no title found")
}
