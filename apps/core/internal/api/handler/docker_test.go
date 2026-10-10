package handler

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/discovery"
	dockerproxy "caorushizi.cn/mediago/internal/docker"
	"github.com/gin-gonic/gin"
)

type fakeDockerForwarder struct {
	err      error
	request  dockerproxy.ForwardRequest
	response dockerproxy.ForwardResponse
}

func TestDockerHandlerForwardsDiscoverySourcesWithPrivateHeaders(t *testing.T) {
	store := discovery.NewStore(discovery.StoreOptions{
		NewID: func() string { return "job-private" },
		Now:   func() time.Time { return time.Date(2026, 8, 29, 0, 0, 0, 0, time.UTC) },
	})
	job, err := store.Create(discovery.CreateDiscoveryInput{
		URL:       "https://example.com/watch",
		Mode:      discovery.ModeBrowser,
		TimeoutMS: discovery.DefaultTimeoutMS,
	}, discovery.ExecutionInspect)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Start(job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Complete(job.ID, []discovery.PrivateSource{{
		DiscoverySource: discovery.DiscoverySource{
			ID: "source-1", URL: "https://cdn.example.com/play", Title: "Original", Type: discovery.SourceTypeM3U8,
			Variants: []discovery.HLSVariant{{URL: "https://cdn.example.com/720", Quality: "720p"}},
		},
		Headers: []string{"Cookie: session=secret", "Referer: https://example.com/watch"},
	}}, false); err != nil {
		t.Fatal(err)
	}
	forwarder := &fakeDockerForwarder{response: dockerproxy.ForwardResponse{
		StatusCode: http.StatusOK, ContentType: "application/json", Body: []byte(`{"success":true}`),
	}}
	handler := NewDockerHandler(forwarder, discovery.NewService(store, nil, nil))
	router := gin.New()
	router.POST("/api/docker/discoveries/:id/downloads", handler.DiscoveryDownloads)
	body := []byte(`{"sourceIds":["source-1"],"variantUrls":{"source-1":"https://cdn.example.com/720"},"names":{"source-1":"Episode"},"folder":"season","startDownload":true}`)
	request := httptest.NewRequest(http.MethodPost, "/api/docker/discoveries/job-private/downloads", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	forwardedBody, _ := io.ReadAll(forwarder.request.Body)
	text := string(forwardedBody)
	if response.Code != http.StatusOK || !bytes.Contains(forwardedBody, []byte(`"name":"Episode"`)) || !bytes.Contains(forwardedBody, []byte(`"url":"https://cdn.example.com/720"`)) || !bytes.Contains(forwardedBody, []byte(`Cookie: session=secret`)) || !bytes.Contains(forwardedBody, []byte(`"startDownload":true`)) {
		t.Fatalf("response/body = %d %s / %s", response.Code, response.Body.String(), text)
	}
}

func (f *fakeDockerForwarder) Forward(_ context.Context, _ string, request dockerproxy.ForwardRequest) (dockerproxy.ForwardResponse, error) {
	f.request = request
	return f.response, f.err
}

func TestDockerHandlerForwardsKnownDownloadRouteWithoutReencodingBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	payload := []byte(`{"tasks":[{"url":"https://example.com/play","headers":"Cookie: secret"}],"startDownload":true}`)
	forwarder := &fakeDockerForwarder{response: dockerproxy.ForwardResponse{
		StatusCode:  http.StatusCreated,
		ContentType: "application/json",
		Body:        []byte(`{"success":true}`),
	}}
	handler := NewDockerHandler(forwarder)
	router := gin.New()
	router.POST("/api/docker/downloads", handler.Create)

	request := httptest.NewRequest(http.MethodPost, "/api/docker/downloads?from=home", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	forwardedBody, _ := io.ReadAll(forwarder.request.Body)
	if response.Code != http.StatusCreated || response.Body.String() != `{"success":true}` {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if forwarder.request.Path != "/api/downloads" || forwarder.request.RawQuery != "from=home" || !bytes.Equal(forwardedBody, payload) {
		t.Fatalf("forwarded request = %+v, body = %s", forwarder.request, forwardedBody)
	}
}

func TestDockerHandlerMapsProxyFailuresToBadGateway(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewDockerHandler(&fakeDockerForwarder{err: errors.New("dial failed")})
	router := gin.New()
	router.GET("/api/docker/downloads", handler.List)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/docker/downloads", nil))

	if response.Code != http.StatusBadGateway || !bytes.Contains(response.Body.Bytes(), []byte("docker_proxy_failed")) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestDockerHandlerForwardsExplicitTaskRoutesAndRemoteErrors(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		requestURL string
		wantPath   string
		register   func(*gin.Engine, *DockerHandler)
	}{
		{name: "list", method: http.MethodGet, requestURL: "/api/docker/downloads?filter=done", wantPath: "/api/downloads", register: func(router *gin.Engine, handler *DockerHandler) { router.GET("/api/docker/downloads", handler.List) }},
		{name: "update", method: http.MethodPut, requestURL: "/api/docker/downloads/9", wantPath: "/api/downloads/9", register: func(router *gin.Engine, handler *DockerHandler) {
			router.PUT("/api/docker/downloads/:id", handler.Update)
		}},
		{name: "start", method: http.MethodPost, requestURL: "/api/docker/downloads/9/start", wantPath: "/api/downloads/9/start", register: func(router *gin.Engine, handler *DockerHandler) {
			router.POST("/api/docker/downloads/:id/start", handler.Start)
		}},
		{name: "logs", method: http.MethodGet, requestURL: "/api/docker/downloads/9/logs", wantPath: "/api/downloads/9/logs", register: func(router *gin.Engine, handler *DockerHandler) {
			router.GET("/api/docker/downloads/:id/logs", handler.Logs)
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			forwarder := &fakeDockerForwarder{response: dockerproxy.ForwardResponse{
				StatusCode:  http.StatusConflict,
				ContentType: "application/json",
				Body:        []byte(`{"success":false,"message":"remote conflict"}`),
			}}
			handler := NewDockerHandler(forwarder)
			router := gin.New()
			test.register(router, handler)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(test.method, test.requestURL, nil))

			if response.Code != http.StatusConflict || forwarder.request.Path != test.wantPath || !bytes.Contains(response.Body.Bytes(), []byte("remote conflict")) {
				t.Fatalf("response/request = %d %s / %+v", response.Code, response.Body.String(), forwarder.request)
			}
		})
	}
}
