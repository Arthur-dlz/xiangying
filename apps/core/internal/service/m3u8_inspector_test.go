package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type inspectorTestConfig struct {
	values map[string]any
}

func (c inspectorTestConfig) Get(key string) any { return c.values[key] }

func TestM3U8InspectorParsesMasterPlaylistAndForwardsHeaders(t *testing.T) {
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		if got := r.Header.Get("Referer"); got != "https://example.com/watch/video" {
			t.Errorf("Referer = %q", got)
		}
		if got := r.Header.Get("User-Agent"); got != "MediaGo-Test" {
			t.Errorf("User-Agent = %q", got)
		}
		if got := r.Header.Get("Accept-Encoding"); strings.Contains(got, "br") {
			t.Errorf("unsupported captured Accept-Encoding was forwarded: %q", got)
		}
		_, _ = w.Write([]byte(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8?token=test
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=4500000,BANDWIDTH=5000000,RESOLUTION=1920x1080
/1080/index.m3u8?token=test
`))
	}))
	defer server.Close()

	inspector := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}})
	input := InspectSourceInput{
		ID:  "source-1",
		URL: server.URL + "/master/index.m3u8",
		Headers: []string{
			"Referer: https://example.com/watch/video",
			"User-Agent: MediaGo-Test",
			"Accept-Encoding: gzip, br",
		},
	}
	result := inspector.Inspect(context.Background(), input)

	if result.Error != "" {
		t.Fatalf("Inspect() error = %q", result.Error)
	}
	if result.PlaylistType != "master" || result.MaxQuality != "1080p" {
		t.Fatalf("unexpected inspection: %+v", result)
	}
	if len(result.Variants) != 2 {
		t.Fatalf("variants = %d, want 2", len(result.Variants))
	}
	if got := result.Variants[0].URL; got != server.URL+"/master/720/index.m3u8?token=test" {
		t.Fatalf("resolved variant URL = %q", got)
	}
	if result.Variants[0].Codecs != "avc1.4d401f,mp4a.40.2" {
		t.Fatalf("codecs = %q", result.Variants[0].Codecs)
	}

	cached := inspector.Inspect(context.Background(), InspectSourceInput{
		ID: "source-2", URL: input.URL, Headers: input.Headers,
	})
	if cached.ID != "source-2" || requestCount.Load() != 1 {
		t.Fatalf("cache result = %+v, requests = %d", cached, requestCount.Load())
	}
}

func TestM3U8InspectorDoesNotFetchAbsoluteVariantURLs(t *testing.T) {
	var variantRequestCount atomic.Int32
	variantServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		variantRequestCount.Add(1)
		_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n"))
	}))
	defer variantServer.Close()

	masterServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "closure_dummy_cookie_marker" {
			t.Error("master request did not receive its explicit test Cookie")
		}
		_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n" + variantServer.URL + "/variant.m3u8\n"))
	}))
	defer masterServer.Close()

	result := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}}).Inspect(
		context.Background(),
		InspectSourceInput{
			ID:      "absolute-variant",
			URL:     masterServer.URL + "/master.m3u8",
			Headers: []string{"Cookie: closure_dummy_cookie_marker"},
		},
	)
	if result.Error != "" || result.PlaylistType != "master" || len(result.Variants) != 1 {
		t.Fatalf("unexpected master inspection: errorCode=%q playlistType=%q variants=%d", result.ErrorCode, result.PlaylistType, len(result.Variants))
	}
	if got, want := result.Variants[0].URL, variantServer.URL+"/variant.m3u8"; got != want {
		t.Fatalf("absolute variant URL = %q, want %q", got, want)
	}
	if got := variantRequestCount.Load(); got != 0 {
		t.Fatalf("inspector fetched an absolute variant %d times; it should only report its URL", got)
	}
}

func TestM3U8InspectorScopesPrivateHeadersToThePlaylistOrigin(t *testing.T) {
	tests := []struct {
		name           string
		redirectOrigin string
		wantRedirect   bool
	}{
		{name: "same origin", redirectOrigin: "same", wantRedirect: true},
		{name: "same hostname different port", redirectOrigin: "port"},
		{name: "different hostname", redirectOrigin: "host"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var initial, redirected requestHeaderMarkers
			var destination *httptest.Server
			if test.redirectOrigin != "same" {
				destination = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					redirected = inspectRequestHeaderMarkers(r)
					writeProbeMediaPlaylist(w)
				}))
				defer destination.Close()
			}

			var source *httptest.Server
			source = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/master.m3u8" {
					initial = inspectRequestHeaderMarkers(r)
					redirectURL := ""
					if test.redirectOrigin == "same" {
						redirectURL = source.URL + "/final.m3u8"
					} else {
						redirectURL = destination.URL + "/final.m3u8"
					}
					if test.redirectOrigin == "host" {
						redirectURL = strings.Replace(redirectURL, "127.0.0.1", "localhost", 1)
					}
					http.Redirect(w, r, redirectURL, http.StatusFound)
					return
				}
				redirected = inspectRequestHeaderMarkers(r)
				writeProbeMediaPlaylist(w)
			}))
			defer source.Close()

			input := InspectSourceInput{
				ID:  "origin-scope",
				URL: source.URL + "/master.m3u8",
				Headers: []string{
					"Cookie: closure_dummy_cookie_marker",
					"Authorization: Bearer closure_dummy_auth_marker",
					"Proxy-Authorization: Basic closure_dummy_proxy_marker",
					"Referer: https://example.invalid/watch",
					"Accept: application/vnd.apple.mpegurl",
				},
			}
			result := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}}).Inspect(context.Background(), input)
			if result.Error != "" || result.PlaylistType != "media" {
				t.Fatalf("inspection failed: errorCode=%q playlistType=%q", result.ErrorCode, result.PlaylistType)
			}
			wantInitial := requestHeaderMarkers{
				cookie: true, authorization: true, proxyAuthorization: true,
				referer: true, accept: true,
			}
			if initial != wantInitial {
				t.Fatalf("initial request marker summary = %+v, want %+v", initial, wantInitial)
			}
			wantRedirected := requestHeaderMarkers{referer: true, accept: true}
			if test.wantRedirect {
				wantRedirected.cookie = true
				wantRedirected.authorization = true
				wantRedirected.proxyAuthorization = true
			}
			if redirected != wantRedirected {
				t.Fatalf("redirect request marker summary = %+v, want %+v", redirected, wantRedirected)
			}
		})
	}
}

func TestM3U8InspectorDropsUnapprovedSecretHeaders(t *testing.T) {
	var received requestHeaderMarkers
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = inspectRequestHeaderMarkers(r)
		writeProbeMediaPlaylist(w)
	}))
	defer server.Close()

	result := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}}).Inspect(
		context.Background(),
		InspectSourceInput{
			ID:  "unknown-secret-header",
			URL: server.URL + "/master.m3u8",
			Headers: []string{
				"Cookie: closure_dummy_cookie_marker",
				"Authorization: Bearer closure_dummy_auth_marker",
				"Proxy-Authorization: Basic closure_dummy_proxy_marker",
				"X-Api-Key: closure_dummy_api_key_marker",
				"Referer: https://example.invalid/watch",
				"Accept: application/vnd.apple.mpegurl",
			},
		},
	)
	if result.Error != "" || result.PlaylistType != "media" {
		t.Fatalf("inspection failed: errorCode=%q playlistType=%q", result.ErrorCode, result.PlaylistType)
	}
	want := requestHeaderMarkers{
		cookie: true, authorization: true, proxyAuthorization: true,
		referer: true, accept: true,
	}
	if received != want {
		t.Fatalf("request marker summary = %+v, want %+v", received, want)
	}
}

func TestSameInspectionOriginUsesSchemeHostnameAndEffectivePort(t *testing.T) {
	tests := []struct {
		name  string
		left  string
		right string
		want  bool
	}{
		{name: "implicit and explicit default http port", left: "http://example.test/a", right: "http://example.test:80/b", want: true},
		{name: "leading zero normalizes the effective port", left: "http://example.test:080/a", right: "http://EXAMPLE.TEST./b", want: true},
		{name: "different port is a different origin", left: "http://example.test:8080/a", right: "http://example.test:8081/b"},
		{name: "different scheme is a different origin", left: "http://example.test/a", right: "https://example.test/a"},
		{name: "different hostname is a different origin", left: "http://example.test/a", right: "http://other.test/a"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			left, err := url.Parse(test.left)
			if err != nil {
				t.Fatalf("parse left origin: %v", err)
			}
			right, err := url.Parse(test.right)
			if err != nil {
				t.Fatalf("parse right origin: %v", err)
			}
			if got := sameInspectionOrigin(left, right); got != test.want {
				t.Fatalf("sameInspectionOrigin() = %t, want %t", got, test.want)
			}
		})
	}
}

type requestHeaderMarkers struct {
	cookie             bool
	authorization      bool
	proxyAuthorization bool
	apiKey             bool
	referer            bool
	accept             bool
}

func inspectRequestHeaderMarkers(r *http.Request) requestHeaderMarkers {
	return requestHeaderMarkers{
		cookie:             r.Header.Get("Cookie") == "closure_dummy_cookie_marker",
		authorization:      r.Header.Get("Authorization") == "Bearer closure_dummy_auth_marker",
		proxyAuthorization: r.Header.Get("Proxy-Authorization") == "Basic closure_dummy_proxy_marker",
		apiKey:             r.Header.Get("X-Api-Key") == "closure_dummy_api_key_marker",
		referer:            r.Header.Get("Referer") == "https://example.invalid/watch",
		accept:             r.Header.Get("Accept") == "application/vnd.apple.mpegurl",
	}
}

func writeProbeMediaPlaylist(w http.ResponseWriter) {
	_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n"))
}

func TestM3U8InspectorIdentifiesMediaPlaylist(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("\ufeff\n  \n#EXTM3U\n" + `
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
segment-1.ts
`))
	}))
	defer server.Close()

	inspector := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}})
	result := inspector.Inspect(context.Background(), InspectSourceInput{ID: "media", URL: server.URL + "/signed/play?id=1"})
	if result.Error != "" || result.PlaylistType != "media" || result.MaxQuality != "" {
		t.Fatalf("unexpected inspection: %+v", result)
	}
}

func TestM3U8InspectorUsesFinalRedirectURLForRelativeVariants(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/start", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/cdn/master/index", http.StatusFound)
	})
	mux.HandleFunc("/cdn/master/index", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\nvariants/720\n"))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	inspector := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}})
	result := inspector.Inspect(context.Background(), InspectSourceInput{ID: "redirect", URL: server.URL + "/start"})
	if result.Error != "" || len(result.Variants) != 1 {
		t.Fatalf("unexpected inspection: %+v", result)
	}
	if got, want := result.Variants[0].URL, server.URL+"/cdn/master/variants/720"; got != want {
		t.Fatalf("variant URL = %q, want %q", got, want)
	}
}

func TestM3U8InspectorClassifiesNonHLSAndBoundedFailures(t *testing.T) {
	t.Run("not hls", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte("<html>not a playlist</html>"))
		}))
		defer server.Close()

		result := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}}).Inspect(
			context.Background(),
			InspectSourceInput{ID: "html", URL: server.URL + "/play"},
		)
		if result.ErrorCode != InspectionErrorNotHLS || result.Error == "" {
			t.Fatalf("unexpected result: %+v", result)
		}
	})

	t.Run("too large", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("#EXTM3U\n"))
			_, _ = w.Write([]byte(strings.Repeat("#", maxManifestBytes)))
		}))
		defer server.Close()

		result := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}}).Inspect(
			context.Background(),
			InspectSourceInput{ID: "large", URL: server.URL + "/play"},
		)
		if result.ErrorCode != InspectionErrorTooLarge {
			t.Fatalf("unexpected result: %+v", result)
		}
	})

	t.Run("cancelled request", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(100 * time.Millisecond)
			_, _ = w.Write([]byte("#EXTM3U\n"))
		}))
		defer server.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		defer cancel()
		result := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}}).Inspect(
			ctx,
			InspectSourceInput{ID: "timeout", URL: server.URL + "/play"},
		)
		if result.ErrorCode != InspectionErrorFetch {
			t.Fatalf("unexpected result: %+v", result)
		}
	})
}

func TestM3U8InspectorReturnsPerSourceErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not a playlist"))
	}))
	defer server.Close()

	inspector := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}})
	results := inspector.InspectBatch(context.Background(), []InspectSourceInput{
		{ID: "invalid", URL: server.URL},
		{ID: "unsupported", URL: "file:///tmp/video.m3u8"},
	})
	if len(results) != 2 || results[0].Error == "" || results[1].Error == "" {
		t.Fatalf("unexpected results: %+v", results)
	}
}
