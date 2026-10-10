package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDefaultInspectHeaderRedirectProbe(t *testing.T) {
	const cookieMarker = "closure_dummy_cookie_marker"
	const authMarker = "closure_dummy_auth_marker"

	for _, testCase := range []struct {
		name       string
		changeHost bool
		wantCookie bool
		wantAuth   bool
	}{
		{name: "same host different port", wantCookie: false, wantAuth: false},
		{name: "different host localhost alias", changeHost: true, wantCookie: false, wantAuth: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var destinationCookie, destinationAuth atomic.Bool
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				destinationCookie.Store(r.Header.Get("Cookie") == cookieMarker)
				destinationAuth.Store(r.Header.Get("Authorization") == "Bearer "+authMarker)
				_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n"))
			}))
			defer destination.Close()

			destinationURL := destination.URL
			if testCase.changeHost {
				destinationURL = strings.Replace(destinationURL, "127.0.0.1", "localhost", 1)
			}
			var sourceCookie, sourceAuth atomic.Bool
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sourceCookie.Store(r.Header.Get("Cookie") == cookieMarker)
				sourceAuth.Store(r.Header.Get("Authorization") == "Bearer "+authMarker)
				http.Redirect(w, r, destinationURL, http.StatusFound)
			}))
			defer source.Close()

			input := InspectSourceInput{
				ID:  "default-user-context",
				URL: source.URL + "/master.m3u8",
				Headers: []string{
					"Cookie: " + cookieMarker,
					"Authorization: Bearer " + authMarker,
					"Referer: http://127.0.0.1/watch",
				},
			}
			result := NewM3U8Inspector(inspectorTestConfig{values: map[string]any{}}).Inspect(context.Background(), input)
			if result.Error != "" || result.PlaylistType != "media" {
				t.Fatalf("inspection failed: errorCode=%q playlistType=%q", result.ErrorCode, result.PlaylistType)
			}
			if !sourceCookie.Load() || !sourceAuth.Load() {
				t.Fatalf("initial inspection request did not receive expected dummy sensitive headers: cookie=%t auth=%t", sourceCookie.Load(), sourceAuth.Load())
			}
			if destinationCookie.Load() != testCase.wantCookie || destinationAuth.Load() != testCase.wantAuth {
				t.Fatalf("redirect sensitive-header booleans cookie=%t auth=%t, want cookie=%t auth=%t", destinationCookie.Load(), destinationAuth.Load(), testCase.wantCookie, testCase.wantAuth)
			}
			t.Logf("sensitive header observation only: initial_cookie=%t initial_auth=%t redirect_cookie=%t redirect_auth=%t", sourceCookie.Load(), sourceAuth.Load(), destinationCookie.Load(), destinationAuth.Load())
		})
	}
}
