package service

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
	"golang.org/x/text/width"
)

const (
	socialExcerptMaxDisplayWidth = 64
	socialMinimumSentenceWidth   = 24
	maxSocialTitleBytes          = 180
)

var (
	xStatusPathPattern = regexp.MustCompile(`^/([A-Za-z0-9_]{1,15})/status/([0-9]+)(?:/|$)`)
	socialLeadingCount = regexp.MustCompile(`^\([0-9]+\)\s*`)
	xChinesePagePrefix = regexp.MustCompile(`(?i)^X\s*上的\s*.+?[：:]\s*[“"]?`)
	xLatinPagePrefix   = regexp.MustCompile(`(?i)^.+?\s+(?:on|su)\s+X\s*[：:]\s*[“"]?`)
	xPageSuffix        = regexp.MustCompile(`(?i)\s+[-—–|/]\s*X\s*$`)
	socialHTTPURL      = regexp.MustCompile(`(?i)https?://[a-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+`)
)

type normalizedSocialTitle struct {
	name     string
	statusID string
}

func normalizeXDownloadTitle(rawName, rawURL string) (normalizedSocialTitle, bool) {
	handle, statusID, ok := parseXStatusURL(rawURL)
	if !ok {
		return normalizedSocialTitle{}, false
	}

	body := cleanXSourceTitle(rawName)
	if body == "" {
		body = "X video"
	} else {
		body = excerptSocialSourceTitle(body)
	}

	name := fmt.Sprintf("@%s · %s", handle, body)
	return normalizedSocialTitle{
		name:     truncateUTF8Bytes(name, maxSocialTitleBytes),
		statusID: statusID,
	}, true
}

func parseXStatusURL(rawURL string) (string, string, bool) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", "", false
	}
	hostname := strings.ToLower(parsed.Hostname())
	switch hostname {
	case "x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com":
	default:
		return "", "", false
	}

	match := xStatusPathPattern.FindStringSubmatch(parsed.Path)
	if len(match) != 3 {
		return "", "", false
	}
	return match[1], match[2], true
}

func cleanXSourceTitle(rawName string) string {
	original := strings.TrimSpace(norm.NFKC.String(rawName))
	candidate := socialLeadingCount.ReplaceAllString(original, "")

	switch {
	case xChinesePagePrefix.MatchString(candidate):
		candidate = xChinesePagePrefix.ReplaceAllString(candidate, "")
		candidate = xPageSuffix.ReplaceAllString(candidate, "")
	case xPageSuffix.MatchString(candidate) && xLatinPagePrefix.MatchString(candidate):
		candidate = xLatinPagePrefix.ReplaceAllString(candidate, "")
		candidate = xPageSuffix.ReplaceAllString(candidate, "")
	default:
		candidate = original
	}

	return cleanSocialSourceTitle(candidate)
}

func cleanSocialSourceTitle(rawName string) string {
	candidate := strings.TrimSpace(norm.NFKC.String(rawName))
	candidate = socialHTTPURL.ReplaceAllString(candidate, " ")
	candidate = strings.Join(strings.Fields(candidate), " ")
	return strings.Trim(candidate, " \t\r\n\"'“”")
}

func excerptSocialSourceTitle(value string) string {
	target := value
	omitted := false
	displayWidth := 0

	for index, character := range value {
		displayWidth += socialRuneDisplayWidth(character)
		if displayWidth < socialMinimumSentenceWidth || !isSocialSentenceTerminator(character) {
			continue
		}
		end := index + utf8.RuneLen(character)
		if strings.TrimSpace(value[end:]) != "" {
			target = value[:end]
			omitted = true
		}
		break
	}

	shortened, truncated := truncateSocialDisplayWidth(target, socialExcerptMaxDisplayWidth)
	omitted = omitted || truncated
	if omitted && !strings.HasSuffix(shortened, "…") {
		shortened += "…"
	}
	return shortened
}

func truncateSocialDisplayWidth(value string, maximum int) (string, bool) {
	used := 0
	cutIndex := len(value)
	boundaryIndex := -1
	boundaryWidth := 0

	for index, character := range value {
		characterWidth := socialRuneDisplayWidth(character)
		if used+characterWidth > maximum {
			cutIndex = index
			break
		}
		used += characterWidth
		if isSocialTitleBoundary(character) {
			boundaryIndex = index + utf8.RuneLen(character)
			boundaryWidth = used
		}
	}
	if cutIndex == len(value) {
		return value, false
	}
	if boundaryWidth >= maximum*3/5 {
		cutIndex = boundaryIndex
	}
	shortened := strings.TrimSpace(value[:cutIndex])
	shortened = strings.TrimRight(shortened, "，,、;；:：")
	return shortened, true
}

func socialRuneDisplayWidth(character rune) int {
	if character == '\u200d' || unicode.Is(unicode.Mn, character) || unicode.Is(unicode.Me, character) || unicode.Is(unicode.Cf, character) {
		return 0
	}
	switch width.LookupRune(character).Kind() {
	case width.EastAsianWide, width.EastAsianFullwidth:
		return 2
	default:
		return 1
	}
}

func isSocialSentenceTerminator(character rune) bool {
	return strings.ContainsRune("。！？!?", character)
}

func isSocialTitleBoundary(character rune) bool {
	return unicode.IsSpace(character) || strings.ContainsRune("，,、;；:：", character)
}

func truncateUTF8Bytes(value string, maximum int) string {
	if len(value) <= maximum {
		return value
	}
	const ellipsis = "…"
	limit := maximum - len(ellipsis)
	end := 0
	for index, character := range value {
		next := index + utf8.RuneLen(character)
		if next > limit {
			break
		}
		end = next
	}
	shortened := strings.TrimSpace(value[:end])
	shortened = strings.TrimRight(shortened, "，,、;；:：…")
	return shortened + ellipsis
}

func appendSocialIDSuffix(title, statusID string) string {
	if len(statusID) > 8 {
		statusID = statusID[len(statusID)-8:]
	}
	suffix := fmt.Sprintf(" [%s]", statusID)
	base := truncateUTF8Bytes(title, maxSocialTitleBytes-len(suffix))
	return base + suffix
}
