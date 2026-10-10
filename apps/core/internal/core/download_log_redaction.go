package core

import (
	"net/url"
	"regexp"
	"strings"
)

var downloaderLogURLPattern = regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://[^\s"'<>]+`)

// redactURLsFromDownloaderLog removes URL credentials and query/fragment data
// from a downloader console line while preserving the surrounding diagnostics.
func redactURLsFromDownloaderLog(line string) string {
	return downloaderLogURLPattern.ReplaceAllStringFunc(line, func(candidate string) string {
		trimmed := candidate
		trailing := ""
		for len(trimmed) > 0 && strings.ContainsRune(".,;!?)]}", rune(trimmed[len(trimmed)-1])) {
			// Keep punctuation outside the URL intact after sanitizing.
			trailing = trimmed[len(trimmed)-1:] + trailing
			trimmed = trimmed[:len(trimmed)-1]
		}
		parsed, err := url.Parse(trimmed)
		if err != nil {
			schemeEnd := strings.Index(trimmed, "://")
			if schemeEnd < 0 {
				return "[REDACTED]" + trailing
			}
			return trimmed[:schemeEnd+3] + "[REDACTED]" + trailing
		}
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.ForceQuery = false
		parsed.Fragment = ""
		parsed.RawFragment = ""
		return parsed.String() + trailing
	})
}
