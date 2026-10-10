package server

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
)

func TestHandleWebShareTargetRedirectsMultipartFields(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	mediaURL := "https://media.example/live.m3u8?token=a&expires=2"
	for name, value := range map[string]string{
		"title": " Episode 1 ",
		"text":  "Shared from Android",
		"url":   mediaURL,
	} {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/share", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := serveWebShareTarget(request)

	if recorder.Code != http.StatusSeeOther {
		t.Fatalf("expected status %d, got %d", http.StatusSeeOther, recorder.Code)
	}
	values := shareRedirectValues(t, recorder.Header().Get("Location"))
	if values.Get("title") != "Episode 1" {
		t.Fatalf("unexpected title: %q", values.Get("title"))
	}
	if values.Get("text") != "Shared from Android" {
		t.Fatalf("unexpected text: %q", values.Get("text"))
	}
	if values.Get("url") != mediaURL {
		t.Fatalf("unexpected URL: %q", values.Get("url"))
	}
}

func TestHandleWebShareTargetRejectsOversizedBodies(t *testing.T) {
	gin.SetMode(gin.TestMode)

	form := url.Values{"url": {strings.Repeat("a", webShareMaxBodyBytes)}}
	request := httptest.NewRequest(
		http.MethodPost,
		"/share",
		strings.NewReader(form.Encode()),
	)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recorder := serveWebShareTarget(request)

	if recorder.Code != http.StatusSeeOther {
		t.Fatalf("expected status %d, got %d", http.StatusSeeOther, recorder.Code)
	}
	if location := recorder.Header().Get("Location"); location != "/#/share" {
		t.Fatalf("expected invalid-share redirect, got %q", location)
	}
}

func TestServeEmbeddedMainUIExposesPwaResourcesAndFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)

	files := fstest.MapFS{
		"web/index.html":        {Data: []byte("<html>MediaGo</html>")},
		"web/manifest.json":     {Data: []byte("{\"name\":\"MediaGo\"}")},
		"web/service-worker.js": {Data: []byte("self.addEventListener('fetch', () => {});")},
	}

	engine := gin.New()
	server := &Server{engine: engine}
	server.serveEmbeddedMainUI(files)

	manifestRequest := httptest.NewRequest(http.MethodGet, "/manifest.json", nil)
	manifestRecorder := httptest.NewRecorder()
	engine.ServeHTTP(manifestRecorder, manifestRequest)
	if manifestRecorder.Code != http.StatusOK {
		t.Fatalf("manifest returned status %d", manifestRecorder.Code)
	}
	if !strings.Contains(manifestRecorder.Body.String(), "MediaGo") {
		t.Fatalf("unexpected manifest body: %q", manifestRecorder.Body.String())
	}

	workerRequest := httptest.NewRequest(http.MethodGet, "/service-worker.js", nil)
	workerRecorder := httptest.NewRecorder()
	engine.ServeHTTP(workerRecorder, workerRequest)
	if workerRecorder.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf(
			"unexpected service worker cache header: %q",
			workerRecorder.Header().Get("Cache-Control"),
		)
	}

	shareRequest := httptest.NewRequest(
		http.MethodPost,
		"/share",
		strings.NewReader("url=https%3A%2F%2Fexample.com%2Fvideo.mp4"),
	)
	shareRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	shareRecorder := httptest.NewRecorder()
	engine.ServeHTTP(shareRecorder, shareRequest)
	if shareRecorder.Code != http.StatusSeeOther {
		t.Fatalf("share target returned status %d", shareRecorder.Code)
	}

	missingPost := httptest.NewRequest(http.MethodPost, "/missing", nil)
	missingPostRecorder := httptest.NewRecorder()
	engine.ServeHTTP(missingPostRecorder, missingPost)
	if missingPostRecorder.Code != http.StatusNotFound {
		t.Fatalf("unmatched POST returned status %d", missingPostRecorder.Code)
	}

	spaRequest := httptest.NewRequest(http.MethodGet, "/settings", nil)
	spaRecorder := httptest.NewRecorder()
	engine.ServeHTTP(spaRecorder, spaRequest)
	if spaRecorder.Code != http.StatusOK {
		t.Fatalf("SPA fallback returned status %d", spaRecorder.Code)
	}
	if !strings.Contains(spaRecorder.Body.String(), "MediaGo") {
		t.Fatalf("unexpected SPA fallback body: %q", spaRecorder.Body.String())
	}
	if contentType := spaRecorder.Header().Get("Content-Type"); strings.Count(contentType, "charset=") != 1 {
		t.Fatalf("unexpected SPA content type: %q", contentType)
	}
}

func TestElectronBridgeTokenSuppressesMainUI(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		token string
		want  bool
	}{
		{name: "standalone", token: "", want: true},
		{name: "whitespace", token: "  ", want: true},
		{name: "electron", token: bridgeTestServerToken, want: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := shouldServeMainUI(testCase.token); got != testCase.want {
				t.Fatalf("shouldServeMainUI(%q) = %t, want %t", testCase.token, got, testCase.want)
			}
		})
	}
}

func serveWebShareTarget(request *http.Request) *httptest.ResponseRecorder {
	engine := gin.New()
	engine.POST("/share", handleWebShareTarget)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	return recorder
}

func shareRedirectValues(t *testing.T, location string) url.Values {
	t.Helper()
	const prefix = "/#/share"
	if !strings.HasPrefix(location, prefix) {
		t.Fatalf("unexpected redirect location: %q", location)
	}
	query := strings.TrimPrefix(location, prefix)
	query = strings.TrimPrefix(query, "?")
	values, err := url.ParseQuery(query)
	if err != nil {
		t.Fatal(err)
	}
	return values
}
