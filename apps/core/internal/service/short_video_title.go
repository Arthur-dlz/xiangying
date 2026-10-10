package service

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

var (
	tiktokVideoPathPattern = regexp.MustCompile(`^/@([^/]+)/video/([0-9]+)(?:/|$)`)
	tiktokSharePathPattern = regexp.MustCompile(`^/share/video/([0-9]+)(?:/|$)`)
	douyinVideoPathPattern = regexp.MustCompile(`^/video/([0-9]+)(?:/|$)`)
	shortVideoPageSuffix   = regexp.MustCompile(`(?i)\s+[-—–|/]\s*(?:TikTok|抖音)\s*$`)
)

type shortVideoTitleParts struct {
	fallback string
	prefix   string
	statusID string
}

func normalizeShortVideoDownloadTitle(rawName, rawURL string) (normalizedSocialTitle, bool) {
	parts, ok := parseShortVideoTitleParts(rawURL)
	if !ok {
		return normalizedSocialTitle{}, false
	}

	body := shortVideoPageSuffix.ReplaceAllString(rawName, "")
	body = cleanSocialSourceTitle(body)
	if body == "" {
		return normalizedSocialTitle{
			name:     parts.fallback,
			statusID: parts.statusID,
		}, true
	}
	body = excerptSocialSourceTitle(body)

	return normalizedSocialTitle{
		name:     truncateUTF8Bytes(fmt.Sprintf("%s · %s", parts.prefix, body), maxSocialTitleBytes),
		statusID: parts.statusID,
	}, true
}

func parseShortVideoTitleParts(rawURL string) (shortVideoTitleParts, bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return shortVideoTitleParts{}, false
	}

	hostname := strings.ToLower(parsed.Hostname())
	switch hostname {
	case "vm.tiktok.com", "vt.tiktok.com":
		if !hasShortVideoSharePath(parsed.Path) {
			return shortVideoTitleParts{}, false
		}
		return shortVideoTitleParts{prefix: "TikTok", fallback: "TikTok video"}, true
	case "v.douyin.com":
		if !hasShortVideoSharePath(parsed.Path) {
			return shortVideoTitleParts{}, false
		}
		return shortVideoTitleParts{prefix: "抖音", fallback: "抖音视频"}, true
	case "tiktok.com", "www.tiktok.com", "m.tiktok.com", "tiktokv.com", "www.tiktokv.com":
		if match := tiktokVideoPathPattern.FindStringSubmatch(parsed.Path); len(match) == 3 {
			return shortVideoTitleParts{
				prefix:   "@" + match[1],
				fallback: "TikTok video",
				statusID: match[2],
			}, true
		}
		if match := tiktokSharePathPattern.FindStringSubmatch(parsed.Path); len(match) == 2 {
			return shortVideoTitleParts{
				prefix:   "TikTok",
				fallback: "TikTok video",
				statusID: match[1],
			}, true
		}
		parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		if len(parts) == 2 && parts[0] == "t" && parts[1] != "" {
			return shortVideoTitleParts{prefix: "TikTok", fallback: "TikTok video"}, true
		}
	case "douyin.com", "www.douyin.com":
		if match := douyinVideoPathPattern.FindStringSubmatch(parsed.Path); len(match) == 2 {
			return shortVideoTitleParts{
				prefix:   "抖音",
				fallback: "抖音视频",
				statusID: match[1],
			}, true
		}
	}

	return shortVideoTitleParts{}, false
}

func hasShortVideoSharePath(path string) bool {
	return strings.Trim(path, "/") != ""
}
