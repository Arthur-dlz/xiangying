package core

import (
	"errors"
	"strings"
)

// ErrSensitiveHeadersUnsupported is returned when a download engine cannot
// safely scope credential-like request headers to their original origin.
var ErrSensitiveHeadersUnsupported = errors.New("unsupported sensitive headers for downloads")

// ValidateRequestHeaders applies the explicit-header policy at API boundaries
// as well as when the downloader starts a task.
func ValidateRequestHeaders(downloadType DownloadType, headers []string) error {
	return validateSensitiveHeaderSupport(downloadType, headers)
}

func validateSensitiveHeaderSupport(_ DownloadType, headers []string) error {
	// Validate all supplied headers before considering the engine type. This
	// keeps unknown or future download types from bypassing the policy.
	for _, header := range headers {
		// Reject line breaks so a value cannot smuggle a second header line.
		if strings.ContainsAny(header, "\r\n") {
			return ErrSensitiveHeadersUnsupported
		}
		name, _, ok := strings.Cut(header, ":")
		if !ok || strings.TrimSpace(name) == "" {
			return ErrSensitiveHeadersUnsupported
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "user-agent", "referer", "origin", "accept", "accept-language",
			"accept-encoding", "range":
			continue
		default:
			return ErrSensitiveHeadersUnsupported
		}
	}
	return nil
}
