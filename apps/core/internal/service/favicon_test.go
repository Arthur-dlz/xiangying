package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/db"
)

func TestFaviconResolverUsesDeclaredIconFromOriginalPage(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	requested := make([]string, 0, 2)
	var iconReferer string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requested = append(requested, r.URL.Path)
		mu.Unlock()

		switch r.URL.Path {
		case "/watch/video":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html><head><link rel="icon" href="/assets/site.ico"></head></html>`))
		case "/assets/site.ico":
			mu.Lock()
			iconReferer = r.Header.Get("Referer")
			mu.Unlock()
			w.Header().Set("Content-Type", "image/x-icon")
			_, _ = w.Write([]byte{0x00, 0x00, 0x01, 0x00, 0x01, 0x00})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	resolver := NewFaviconResolver(FaviconResolverOptions{HTTPClient: server.Client()})
	result := resolver.Resolve(context.Background(), server.URL+"/watch/video?token=secret")

	if result.Status != db.FavoriteIconStatusReady {
		t.Fatalf("status = %q, want ready", result.Status)
	}
	if want := server.URL + "/assets/site.ico"; result.Icon != want {
		t.Fatalf("icon = %q, want %q", result.Icon, want)
	}
	mu.Lock()
	defer mu.Unlock()
	if iconReferer != server.URL+"/" {
		t.Fatalf("icon Referer = %q, want origin without original path/query", iconReferer)
	}
	if len(requested) != 2 || requested[0] != "/watch/video" || requested[1] != "/assets/site.ico" {
		t.Fatalf("requested paths = %#v", requested)
	}
}

func TestFaviconResolverUsesDocumentBaseURL(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html><head><base href="/static/"><link rel="shortcut icon" href="icons/site.png"></head></html>`))
		case "/static/icons/site.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nvalid-enough-for-signature-check"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	resolver := NewFaviconResolver(FaviconResolverOptions{HTTPClient: server.Client()})
	result := resolver.Resolve(context.Background(), server.URL+"/page")

	if result.Status != db.FavoriteIconStatusReady || result.Icon != server.URL+"/static/icons/site.png" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFaviconResolverFallsBackToOriginFavicon(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html><head><title>No declared icon</title></head></html>`))
		case "/favicon.ico":
			w.Header().Set("Content-Type", "image/x-icon")
			_, _ = w.Write([]byte{0x00, 0x00, 0x01, 0x00, 0x01, 0x00})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	resolver := NewFaviconResolver(FaviconResolverOptions{HTTPClient: server.Client()})
	result := resolver.Resolve(context.Background(), server.URL+"/page")

	if result.Status != db.FavoriteIconStatusReady || result.Icon != server.URL+"/favicon.ico" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFaviconResolverTriesFallbackAfterDeclaredIconIsMissing(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			_, _ = w.Write([]byte(`<link rel="icon" href="/missing.ico">`))
		case "/favicon.ico":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nvalid"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	resolver := NewFaviconResolver(FaviconResolverOptions{HTTPClient: server.Client()})
	result := resolver.Resolve(context.Background(), server.URL+"/page")

	if result.Status != db.FavoriteIconStatusReady || result.Icon != server.URL+"/favicon.ico" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFaviconResolverClassifiesPermanentMissingResults(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		status      int
		contentType string
		body        string
	}{
		{name: "not found", status: http.StatusNotFound},
		{name: "gone", status: http.StatusGone},
		{name: "invalid image", status: http.StatusOK, contentType: "text/html", body: "<html>not an image</html>"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/page" {
					_, _ = w.Write([]byte(`<html><head></head></html>`))
					return
				}
				if tt.contentType != "" {
					w.Header().Set("Content-Type", tt.contentType)
				}
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			t.Cleanup(server.Close)

			resolver := NewFaviconResolver(FaviconResolverOptions{HTTPClient: server.Client()})
			result := resolver.Resolve(context.Background(), server.URL+"/page")
			if result.Status != db.FavoriteIconStatusMissing || result.Icon != "" {
				t.Fatalf("result = %+v", result)
			}
		})
	}
}

func TestFaviconResolverClassifiesTransientFailuresAsRetryable(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
	}{
		{name: "forbidden", status: http.StatusForbidden},
		{name: "rate limited", status: http.StatusTooManyRequests},
		{name: "server error", status: http.StatusServiceUnavailable},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/page" {
					_, _ = w.Write([]byte(`<html><head></head></html>`))
					return
				}
				w.WriteHeader(tt.status)
			}))
			t.Cleanup(server.Close)

			resolver := NewFaviconResolver(FaviconResolverOptions{HTTPClient: server.Client()})
			result := resolver.Resolve(context.Background(), server.URL+"/page")
			if result.Status != db.FavoriteIconStatusRetryable || result.Icon != "" {
				t.Fatalf("result = %+v", result)
			}
		})
	}
}

func TestFaviconResolverAllowsRetryAfterTimeout(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(100 * time.Millisecond):
			_, _ = w.Write([]byte(`<html></html>`))
		}
	}))
	t.Cleanup(server.Close)

	resolver := NewFaviconResolver(FaviconResolverOptions{
		HTTPClient:     server.Client(),
		RequestTimeout: 15 * time.Millisecond,
		TotalTimeout:   40 * time.Millisecond,
	})
	result := resolver.Resolve(context.Background(), server.URL+"/page")

	if result.Status != db.FavoriteIconStatusRetryable || result.Icon != "" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFaviconResolverRejectsNonHTTPOriginalURL(t *testing.T) {
	t.Parallel()

	resolver := NewFaviconResolver(FaviconResolverOptions{})
	result := resolver.Resolve(context.Background(), "file:///tmp/favicon.ico")

	if result.Status != db.FavoriteIconStatusMissing || result.Icon != "" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFaviconResolverRejectsCredentialedOriginalURL(t *testing.T) {
	t.Parallel()

	resolver := NewFaviconResolver(FaviconResolverOptions{})
	result := resolver.Resolve(context.Background(), "https://user:password@example.com/page")

	if result.Status != db.FavoriteIconStatusMissing || result.Icon != "" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFaviconResolverBlocksNonPublicNetworkTargets(t *testing.T) {
	t.Parallel()

	for _, rawAddress := range []string{
		"127.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"192.168.1.1",
		"100.64.0.1",
		"198.18.0.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
	} {
		address := netip.MustParseAddr(rawAddress)
		if !isUnsafeFaviconIP(address) {
			t.Errorf("address %s unexpectedly allowed", address)
		}
	}

	for _, rawAddress := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		address := netip.MustParseAddr(rawAddress)
		if isUnsafeFaviconIP(address) {
			t.Errorf("address %s unexpectedly blocked", address)
		}
	}

	tunAddress := netip.MustParseAddr("198.18.29.179")
	if !shouldBlockFaviconAddress(tunAddress, true) {
		t.Error("direct TUN synthetic IP unexpectedly allowed")
	}
	if shouldBlockFaviconAddress(tunAddress, false) {
		t.Error("domain-resolved TUN synthetic IP unexpectedly blocked")
	}
	if !shouldBlockFaviconAddress(netip.MustParseAddr("127.0.0.1"), false) {
		t.Error("domain-resolved loopback address unexpectedly allowed")
	}

	resolver := NewFaviconResolver(FaviconResolverOptions{})
	result := resolver.Resolve(context.Background(), "http://127.0.0.1/private")
	if result.Status != db.FavoriteIconStatusMissing {
		t.Fatalf("private network result = %+v, want missing", result)
	}
}
