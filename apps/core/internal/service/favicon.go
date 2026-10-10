package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"
	"time"

	"caorushizi.cn/mediago/internal/db"
	"golang.org/x/net/html"
)

const (
	defaultFaviconRequestTimeout = 5 * time.Second
	defaultFaviconTotalTimeout   = 8 * time.Second
	maxFaviconHTMLBytes          = 512 * 1024
	maxFaviconImageBytes         = 2 * 1024 * 1024
	maxFaviconCandidates         = 8
	faviconUserAgent             = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

var errFaviconTargetNotPublic = errors.New("favicon target resolves to a non-public address")

// FaviconResolution is a deterministic result derived from the original page
// URL and icon metadata returned by that page.
type FaviconResolution struct {
	Icon   string
	Status db.FavoriteIconStatus
}

// FavoriteIconResolver resolves an icon using a favorite's stored original
// URL. Implementations must not select icons from unrelated third parties.
type FavoriteIconResolver interface {
	Resolve(ctx context.Context, originalURL string) FaviconResolution
}

// FaviconResolverOptions makes network behavior injectable for tests.
type FaviconResolverOptions struct {
	HTTPClient     *http.Client
	RequestTimeout time.Duration
	TotalTimeout   time.Duration
}

// FaviconResolver discovers and validates favicons through HTTP.
type FaviconResolver struct {
	client         *http.Client
	requestTimeout time.Duration
	totalTimeout   time.Duration
}

// NewFaviconResolver creates a resolver with bounded request and total times.
func NewFaviconResolver(options FaviconResolverOptions) *FaviconResolver {
	client := options.HTTPClient
	if client == nil {
		client = newFaviconHTTPClient()
	}
	requestTimeout := options.RequestTimeout
	if requestTimeout <= 0 {
		requestTimeout = defaultFaviconRequestTimeout
	}
	totalTimeout := options.TotalTimeout
	if totalTimeout <= 0 {
		totalTimeout = defaultFaviconTotalTimeout
	}
	return &FaviconResolver{
		client:         client,
		requestTimeout: requestTimeout,
		totalTimeout:   totalTimeout,
	}
}

// Resolve fetches the original page, discovers declared favicon URLs, then
// falls back to the original/final origin's /favicon.ico.
func (r *FaviconResolver) Resolve(ctx context.Context, originalURL string) FaviconResolution {
	pageURL, err := parseHTTPURL(originalURL)
	if err != nil {
		return FaviconResolution{Status: db.FavoriteIconStatusMissing}
	}

	ctx, cancel := context.WithTimeout(ctx, r.totalTimeout)
	defer cancel()

	candidates, finalPageURL, pageRetryable := r.discoverCandidates(ctx, pageURL)
	fallbackBase := finalPageURL
	if fallbackBase == nil {
		fallbackBase = pageURL
	}
	fallback := &url.URL{Scheme: fallbackBase.Scheme, Host: fallbackBase.Host, Path: "/favicon.ico"}
	candidates = appendUniqueFaviconCandidate(candidates, fallback)

	hadRetryable := pageRetryable
	for _, candidate := range candidates {
		status := r.validateCandidate(ctx, candidate, pageURL)
		switch status {
		case db.FavoriteIconStatusReady:
			return FaviconResolution{Icon: candidate.String(), Status: status}
		case db.FavoriteIconStatusRetryable:
			hadRetryable = true
		}
	}

	if hadRetryable {
		return FaviconResolution{Status: db.FavoriteIconStatusRetryable}
	}
	return FaviconResolution{Status: db.FavoriteIconStatusMissing}
}

func (r *FaviconResolver) discoverCandidates(ctx context.Context, pageURL *url.URL) ([]*url.URL, *url.URL, bool) {
	response, err := r.doRequest(ctx, pageURL, nil, "text/html,application/xhtml+xml")
	if err != nil {
		return nil, nil, isRetryableFaviconError(err)
	}
	defer response.Body.Close()

	finalURL := response.Request.URL
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, finalURL, isRetryableFaviconStatus(response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxFaviconHTMLBytes))
	if err != nil {
		return nil, finalURL, true
	}
	return extractFaviconCandidates(body, finalURL), finalURL, false
}

func (r *FaviconResolver) validateCandidate(ctx context.Context, candidate, referer *url.URL) db.FavoriteIconStatus {
	response, err := r.doRequest(ctx, candidate, referer, "image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.8")
	if err != nil {
		if isRetryableFaviconError(err) {
			return db.FavoriteIconStatusRetryable
		}
		return db.FavoriteIconStatusMissing
	}
	defer response.Body.Close()

	switch response.StatusCode {
	case http.StatusNotFound, http.StatusGone:
		return db.FavoriteIconStatusMissing
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return db.FavoriteIconStatusRetryable
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxFaviconImageBytes+1))
	if err != nil {
		return db.FavoriteIconStatusRetryable
	}
	if len(body) == 0 || len(body) > maxFaviconImageBytes || !looksLikeImage(body, response.Header.Get("Content-Type")) {
		return db.FavoriteIconStatusMissing
	}
	return db.FavoriteIconStatusReady
}

func (r *FaviconResolver) doRequest(ctx context.Context, target, referer *url.URL, accept string) (*http.Response, error) {
	requestCtx, cancel := context.WithTimeout(ctx, r.requestTimeout)

	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target.String(), nil)
	if err != nil {
		cancel()
		return nil, err
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("User-Agent", faviconUserAgent)
	if referer != nil {
		request.Header.Set("Referer", faviconReferer(referer))
	}

	response, err := r.client.Do(request)
	if err != nil {
		cancel()
		return nil, err
	}
	response.Body = &cancelOnCloseReadCloser{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

func faviconReferer(pageURL *url.URL) string {
	return (&url.URL{Scheme: pageURL.Scheme, Host: pageURL.Host, Path: "/"}).String()
}

type cancelOnCloseReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (body *cancelOnCloseReadCloser) Close() error {
	err := body.ReadCloser.Close()
	body.cancel()
	return err
}

func parseHTTPURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, err
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("favicon URL must use HTTP or HTTPS")
	}
	parsed.Fragment = ""
	return parsed, nil
}

func extractFaviconCandidates(document []byte, pageURL *url.URL) []*url.URL {
	root, err := html.Parse(bytes.NewReader(document))
	if err != nil {
		return nil
	}

	baseURL := pageURL
	if href := firstElementAttribute(root, "base", "href", nil); href != "" {
		if resolved := resolveFaviconReference(pageURL, href); resolved != nil {
			baseURL = resolved
		}
	}

	primary := make([]string, 0, 4)
	secondary := make([]string, 0, 2)
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if len(primary)+len(secondary) >= maxFaviconCandidates {
			return
		}
		if node.Type == html.ElementNode && strings.EqualFold(node.Data, "link") {
			rel := strings.Fields(strings.ToLower(elementAttribute(node, "rel")))
			href := elementAttribute(node, "href")
			if href != "" {
				switch {
				case slices.Contains(rel, "icon"):
					primary = append(primary, href)
				case containsAppleTouchIcon(rel):
					secondary = append(secondary, href)
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)

	candidates := make([]*url.URL, 0, len(primary)+len(secondary))
	for _, href := range append(primary, secondary...) {
		candidate := resolveFaviconReference(baseURL, href)
		if candidate != nil {
			candidates = appendUniqueFaviconCandidate(candidates, candidate)
		}
	}
	return candidates
}

func firstElementAttribute(root *html.Node, element, attribute string, predicate func(*html.Node) bool) string {
	var result string
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if result != "" {
			return
		}
		if node.Type == html.ElementNode && strings.EqualFold(node.Data, element) && (predicate == nil || predicate(node)) {
			result = elementAttribute(node, attribute)
			if result != "" {
				return
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	return result
}

func elementAttribute(node *html.Node, name string) string {
	for _, attribute := range node.Attr {
		if strings.EqualFold(attribute.Key, name) {
			return strings.TrimSpace(attribute.Val)
		}
	}
	return ""
}

func containsAppleTouchIcon(values []string) bool {
	for _, value := range values {
		if strings.HasPrefix(value, "apple-touch-icon") {
			return true
		}
	}
	return false
}

func resolveFaviconReference(baseURL *url.URL, reference string) *url.URL {
	parsed, err := url.Parse(strings.TrimSpace(reference))
	if err != nil {
		return nil
	}
	resolved := baseURL.ResolveReference(parsed)
	if (resolved.Scheme != "http" && resolved.Scheme != "https") || resolved.Host == "" || resolved.User != nil {
		return nil
	}
	resolved.Fragment = ""
	return resolved
}

func appendUniqueFaviconCandidate(candidates []*url.URL, candidate *url.URL) []*url.URL {
	for _, existing := range candidates {
		if existing.String() == candidate.String() {
			return candidates
		}
	}
	return append(candidates, candidate)
}

func isRetryableFaviconStatus(status int) bool {
	return status != http.StatusNotFound && status != http.StatusGone
}

func newFaviconHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = dialPublicFaviconAddress
	transport.MaxConnsPerHost = 4
	transport.MaxIdleConnsPerHost = 2
	transport.ResponseHeaderTimeout = defaultFaviconRequestTimeout

	return &http.Client{
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many favicon redirects")
			}
			_, err := parseHTTPURL(request.URL.String())
			return err
		},
	}
}

func dialPublicFaviconAddress(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}

	addresses := make([]netip.Addr, 0, 2)
	hostIsIPAddress := false
	if parsed, parseErr := netip.ParseAddr(host); parseErr == nil {
		hostIsIPAddress = true
		addresses = append(addresses, parsed)
	} else {
		resolved, resolveErr := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if resolveErr != nil {
			return nil, resolveErr
		}
		addresses = append(addresses, resolved...)
	}

	var dialErrors []error
	dialer := &net.Dialer{Timeout: defaultFaviconRequestTimeout}
	for _, addressIP := range addresses {
		if shouldBlockFaviconAddress(addressIP, hostIsIPAddress) {
			dialErrors = append(dialErrors, errFaviconTargetNotPublic)
			continue
		}
		connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(addressIP.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		dialErrors = append(dialErrors, dialErr)
	}
	if len(dialErrors) == 0 {
		return nil, errors.New("favicon target has no usable address")
	}
	return nil, errors.Join(dialErrors...)
}

func shouldBlockFaviconAddress(address netip.Addr, hostIsIPAddress bool) bool {
	allowTUNSyntheticAddress := !hostIsIPAddress && tunSyntheticFaviconPrefix.Contains(address.Unmap())
	return isUnsafeFaviconIP(address) && !allowTUNSyntheticAddress
}

func isRetryableFaviconError(err error) bool {
	return !errors.Is(err, errFaviconTargetNotPublic)
}

var nonPublicFaviconPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

// Proxy/TUN clients commonly synthesize DNS answers from 198.18.0.0/15. The
// dialer permits those addresses only when they came from resolving a domain;
// a favorite whose URL directly names a benchmark-range IP remains blocked.
var tunSyntheticFaviconPrefix = netip.MustParsePrefix("198.18.0.0/15")

func isUnsafeFaviconIP(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return true
	}
	for _, prefix := range nonPublicFaviconPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func looksLikeImage(body []byte, contentType string) bool {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return false
	}

	if bytes.HasPrefix(body, []byte("\x89PNG\r\n\x1a\n")) ||
		bytes.HasPrefix(body, []byte("\xff\xd8\xff")) ||
		bytes.HasPrefix(body, []byte("GIF87a")) ||
		bytes.HasPrefix(body, []byte("GIF89a")) ||
		bytes.HasPrefix(body, []byte("BM")) ||
		(len(body) >= 12 && bytes.Equal(body[:4], []byte("RIFF")) && bytes.Equal(body[8:12], []byte("WEBP"))) ||
		(len(body) >= 4 && body[0] == 0x00 && body[1] == 0x00 && (body[2] == 0x01 || body[2] == 0x02) && body[3] == 0x00) {
		return true
	}

	lower := bytes.ToLower(trimmed)
	if bytes.HasPrefix(lower, []byte("<svg")) || (bytes.HasPrefix(lower, []byte("<?xml")) && bytes.Contains(lower, []byte("<svg"))) {
		return true
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/") &&
		!bytes.HasPrefix(lower, []byte("<html")) &&
		!bytes.HasPrefix(lower, []byte("<!doctype html"))
}
