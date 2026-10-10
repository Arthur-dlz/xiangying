package discovery

import (
	"errors"
	"time"
)

const (
	DefaultTimeoutMS = 20_000
	MinTimeoutMS     = 3_000
	MaxTimeoutMS     = 30_000
	DefaultCapacity  = 20
	DefaultRetention = 10 * time.Minute
)

type DiscoveryMode string

const (
	ModeAuto    DiscoveryMode = "auto"
	ModeBrowser DiscoveryMode = "browser"
	ModeInspect DiscoveryMode = "inspect"
)

type DiscoveryStatus string

const (
	StatusPending   DiscoveryStatus = "pending"
	StatusRunning   DiscoveryStatus = "running"
	StatusCompleted DiscoveryStatus = "completed"
	StatusFailed    DiscoveryStatus = "failed"
	StatusCancelled DiscoveryStatus = "cancelled"
)

type SourceType string

const (
	SourceTypeM3U8        SourceType = "m3u8"
	SourceTypeBilibili    SourceType = "bilibili"
	SourceTypeDirect      SourceType = "direct"
	SourceTypeMediago     SourceType = "mediago"
	SourceTypeYoutube     SourceType = "youtube"
	SourceTypeXiaohongshu SourceType = "xiaohongshu"
)

type PlaylistType string

const (
	PlaylistTypeMaster  PlaylistType = "master"
	PlaylistTypeMedia   PlaylistType = "media"
	PlaylistTypeUnknown PlaylistType = "unknown"
)

type ExecutionKind string

const (
	ExecutionBrowser ExecutionKind = "browser"
	ExecutionInspect ExecutionKind = "inspect"
)

type CreateDiscoveryInput struct {
	URL               string        `json:"url"`
	Mode              DiscoveryMode `json:"mode"`
	TimeoutMS         int           `json:"timeoutMs"`
	UseSessionCookies bool          `json:"useSessionCookies"`
}

type HLSVariant struct {
	URL       string `json:"url"`
	Quality   string `json:"quality,omitempty"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	Bandwidth int64  `json:"bandwidth,omitempty"`
	Codecs    string `json:"codecs,omitempty"`
}

type DiscoverySource struct {
	ID           string       `json:"id"`
	URL          string       `json:"url"`
	PageURL      string       `json:"pageUrl"`
	Title        string       `json:"title"`
	Type         SourceType   `json:"type"`
	PlaylistType PlaylistType `json:"playlistType,omitempty"`
	MaxQuality   string       `json:"maxQuality,omitempty"`
	Variants     []HLSVariant `json:"variants,omitempty"`
	DetectedAt   time.Time    `json:"detectedAt"`
}

type DiscoveryJob struct {
	ID          string               `json:"id"`
	Input       CreateDiscoveryInput `json:"input"`
	Status      DiscoveryStatus      `json:"status"`
	Sources     []DiscoverySource    `json:"sources"`
	Partial     bool                 `json:"partial"`
	ErrorCode   string               `json:"errorCode,omitempty"`
	Error       string               `json:"error,omitempty"`
	CreatedAt   time.Time            `json:"createdAt"`
	StartedAt   *time.Time           `json:"startedAt,omitempty"`
	CompletedAt *time.Time           `json:"completedAt,omitempty"`
	ExpiresAt   time.Time            `json:"expiresAt"`
}

// PrivateSource exists only inside Core. Headers are deliberately absent from
// DiscoverySource and therefore cannot be serialized through public APIs.
type PrivateSource struct {
	DiscoverySource
	Headers []string `json:"-"`
}

type ExecutorStatus struct {
	Available         bool   `json:"available"`
	ActiveDiscoveryID string `json:"activeDiscoveryId,omitempty"`
	Queued            int    `json:"queued"`
}

var (
	ErrNotFound             = errors.New("discovery not found")
	ErrInvalidURL           = errors.New("discovery URL must use HTTP or HTTPS")
	ErrInvalidMode          = errors.New("invalid discovery mode")
	ErrInvalidInspectURL    = errors.New("inspect mode requires a direct M3U8 URL")
	ErrExecutorUnavailable  = errors.New("browser discovery executor unavailable")
	ErrInspectorUnavailable = errors.New("HLS inspector unavailable")
	ErrQueueFull            = errors.New("discovery queue is full")
	ErrInvalidTransition    = errors.New("invalid discovery state transition")
)

func ErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrNotFound):
		return "discovery_not_found"
	case errors.Is(err, ErrInvalidURL):
		return "discovery_invalid_url"
	case errors.Is(err, ErrInvalidMode):
		return "discovery_invalid_mode"
	case errors.Is(err, ErrInvalidInspectURL):
		return "discovery_invalid_inspect_url"
	case errors.Is(err, ErrExecutorUnavailable):
		return "discovery_executor_unavailable"
	case errors.Is(err, ErrInspectorUnavailable):
		return "discovery_inspector_unavailable"
	case errors.Is(err, ErrQueueFull):
		return "discovery_queue_full"
	case errors.Is(err, ErrInvalidTransition):
		return "discovery_invalid_transition"
	default:
		return "discovery_failed"
	}
}
