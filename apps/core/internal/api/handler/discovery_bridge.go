package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"caorushizi.cn/mediago/internal/api/dto"
	"caorushizi.cn/mediago/internal/discovery"
	"github.com/gin-gonic/gin"
)

const (
	MaxDiscoveryBridgeBodyBytes = 1 << 20
	maxBridgeSources            = 200
	maxBridgeHeadersPerSource   = 100
	maxBridgeHeaderBytes        = 16 << 10
	bridgeKeepaliveInterval     = 15 * time.Second
)

type DiscoveryBridgeHandler struct {
	token  string
	broker *discovery.Broker
	svc    *discovery.Service
}

func NewDiscoveryBridgeHandler(token string, broker *discovery.Broker, svc *discovery.Service) *DiscoveryBridgeHandler {
	return &DiscoveryBridgeHandler{token: token, broker: broker, svc: svc}
}

func (h *DiscoveryBridgeHandler) Events(c *gin.Context) {
	if !h.authorize(c) {
		return
	}
	connection, err := h.broker.Connect()
	if err != nil {
		writeBridgeError(c, http.StatusConflict, "discovery_executor_already_connected", "browser discovery executor already connected")
		return
	}
	defer h.broker.Disconnect(connection)

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	c.Writer.Flush()

	keepalive := time.NewTicker(bridgeKeepaliveInterval)
	defer keepalive.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case command := <-connection.Commands:
			c.SSEvent(command.Type, command)
			c.Writer.Flush()
		case <-keepalive.C:
			_, _ = c.Writer.WriteString(": keepalive\n\n")
			c.Writer.Flush()
		}
	}
}

func (h *DiscoveryBridgeHandler) Start(c *gin.Context) {
	if !h.authorize(c) {
		return
	}
	job, err := h.svc.MarkRunning(c.Param("id"))
	if err != nil {
		writeBridgeDomainError(c, err)
		return
	}
	writeBridgeSuccess(c, job)
}

func (h *DiscoveryBridgeHandler) Complete(c *gin.Context) {
	if !h.authorize(c) {
		return
	}
	var req dto.BridgeDiscoveryCompleteReq
	if !decodeBridgeJSON(c, &req) {
		return
	}
	sources, err := bridgePrivateSources(req.Sources)
	if err != nil {
		writeBridgeError(c, http.StatusBadRequest, "discovery_bridge_invalid_source", "invalid discovery source")
		return
	}
	job, err := h.svc.Complete(c.Request.Context(), c.Param("id"), sources, req.Partial)
	if err != nil {
		writeBridgeDomainError(c, err)
		return
	}
	h.broker.Finish(job.ID)
	writeBridgeSuccess(c, job)
}

func (h *DiscoveryBridgeHandler) Fail(c *gin.Context) {
	if !h.authorize(c) {
		return
	}
	var req dto.BridgeDiscoveryFailReq
	if !decodeBridgeJSON(c, &req) {
		return
	}
	sources, err := bridgePrivateSources(req.Sources)
	if err != nil {
		writeBridgeError(c, http.StatusBadRequest, "discovery_bridge_invalid_source", "invalid discovery source")
		return
	}
	code, message := safeBridgeFailure(req.ErrorCode)
	job, err := h.svc.Fail(c.Request.Context(), c.Param("id"), code, message, sources, req.Partial)
	if err != nil {
		writeBridgeDomainError(c, err)
		return
	}
	h.broker.Finish(job.ID)
	writeBridgeSuccess(c, job)
}

func (h *DiscoveryBridgeHandler) authorize(c *gin.Context) bool {
	if c.GetHeader("Origin") != "" {
		writeBridgeError(c, http.StatusForbidden, "discovery_bridge_origin_forbidden", "browser origins are not allowed")
		return false
	}
	provided := bridgeBearerToken(c.GetHeader("Authorization"))
	expectedHash := sha256.Sum256([]byte(h.token))
	providedHash := sha256.Sum256([]byte(provided))
	if h.token == "" || provided == "" || subtle.ConstantTimeCompare(expectedHash[:], providedHash[:]) != 1 {
		writeBridgeError(c, http.StatusUnauthorized, "discovery_bridge_unauthorized", "unauthorized")
		return false
	}
	return true
}

func bridgeBearerToken(authorization string) string {
	scheme, token, found := strings.Cut(authorization, " ")
	if !found || scheme != "Bearer" || token == "" || strings.Contains(token, " ") {
		return ""
	}
	return token
}

func decodeBridgeJSON(c *gin.Context, destination any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, MaxDiscoveryBridgeBodyBytes)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeBridgeError(c, http.StatusRequestEntityTooLarge, "discovery_bridge_body_too_large", "request body too large")
		} else {
			writeBridgeError(c, http.StatusBadRequest, "discovery_bridge_invalid_request", "invalid request")
		}
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeBridgeError(c, http.StatusBadRequest, "discovery_bridge_invalid_request", "invalid request")
		return false
	}
	return true
}

func bridgePrivateSources(inputs []dto.BridgeDiscoverySourceReq) ([]discovery.PrivateSource, error) {
	if len(inputs) > maxBridgeSources {
		return nil, errors.New("too many bridge sources")
	}
	sources := make([]discovery.PrivateSource, 0, len(inputs))
	seenIDs := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if input.ID == "" || len(input.ID) > 128 || len(input.Title) > 512 || !validBridgeURL(input.URL) || !validBridgeURL(input.PageURL) || !validSourceType(input.Type) {
			return nil, errors.New("invalid bridge source")
		}
		if _, exists := seenIDs[input.ID]; exists {
			return nil, errors.New("duplicate bridge source id")
		}
		seenIDs[input.ID] = struct{}{}
		for _, variant := range input.Variants {
			if !validBridgeURL(variant.URL) {
				return nil, errors.New("invalid bridge variant URL")
			}
		}
		headers, err := normalizeBridgeHeaders(input.Headers)
		if err != nil {
			return nil, err
		}
		detectedAt := input.DetectedAt.UTC()
		if input.DetectedAt.IsZero() {
			detectedAt = time.Now().UTC()
		}
		sources = append(sources, discovery.PrivateSource{
			DiscoverySource: discovery.DiscoverySource{
				ID:           input.ID,
				URL:          input.URL,
				PageURL:      input.PageURL,
				Title:        input.Title,
				Type:         input.Type,
				PlaylistType: input.PlaylistType,
				MaxQuality:   input.MaxQuality,
				Variants:     input.Variants,
				DetectedAt:   detectedAt,
			},
			Headers: headers,
		})
	}
	return sources, nil
}

func validBridgeURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func validSourceType(sourceType discovery.SourceType) bool {
	switch sourceType {
	case discovery.SourceTypeM3U8, discovery.SourceTypeBilibili, discovery.SourceTypeDirect, discovery.SourceTypeMediago, discovery.SourceTypeYoutube, discovery.SourceTypeXiaohongshu:
		return true
	default:
		return false
	}
}

func normalizeBridgeHeaders(headers []string) ([]string, error) {
	if len(headers) > maxBridgeHeadersPerSource {
		return nil, errors.New("too many bridge headers")
	}
	normalized := make([]string, 0, len(headers))
	for _, header := range headers {
		if len(header) > maxBridgeHeaderBytes || strings.ContainsAny(header, "\r\n") {
			return nil, errors.New("invalid bridge header")
		}
		name, value, found := strings.Cut(header, ":")
		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		if !found || !validHeaderName(name) || !validHeaderValue(value) {
			return nil, errors.New("invalid bridge header")
		}
		normalized = append(normalized, http.CanonicalHeaderKey(name)+": "+value)
	}
	return normalized, nil
}

func validHeaderValue(value string) bool {
	for index := 0; index < len(value); index++ {
		char := value[index]
		if (char < 0x20 && char != '\t') || char == 0x7f {
			return false
		}
	}
	return true
}

func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for index := 0; index < len(name); index++ {
		char := name[index]
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') {
			continue
		}
		switch char {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', 96, '|', '~':
			continue
		default:
			return false
		}
	}
	return true
}

func safeBridgeFailure(code string) (string, string) {
	switch code {
	case "discovery_timeout":
		return code, "browser discovery timed out"
	case "discovery_cancelled":
		return code, "browser discovery cancelled"
	case "discovery_navigation_failed":
		return code, "browser navigation failed"
	case "discovery_executor_disconnected":
		return code, "browser discovery executor disconnected"
	default:
		return "discovery_failed", "browser discovery failed"
	}
}

func writeBridgeSuccess(c *gin.Context, data any) {
	c.JSON(http.StatusOK, dto.SuccessResponse{
		Success: true,
		Code:    http.StatusOK,
		Message: "OK",
		Data:    data,
	})
}

func writeBridgeDomainError(c *gin.Context, err error) {
	status := http.StatusBadRequest
	if errors.Is(err, discovery.ErrNotFound) {
		status = http.StatusNotFound
	} else if errors.Is(err, discovery.ErrInvalidTransition) {
		status = http.StatusConflict
	}
	writeBridgeError(c, status, discovery.ErrorCode(err), err.Error())
}

func writeBridgeError(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, dto.ErrorResponse{
		Success:   false,
		Code:      status,
		Message:   message,
		ErrorCode: code,
	})
}
