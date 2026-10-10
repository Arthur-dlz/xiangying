package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"caorushizi.cn/mediago/internal/discovery"
	"github.com/gin-gonic/gin"
)

const bridgeTestToken = "5f866c305dfbb4f8d2d3a1a87626cc2bb0698e41edb5a67da8a530341c3b9d4a"

func TestDiscoveryBridgeRejectsMissingWrongAndCrossOriginCredentials(t *testing.T) {
	router, broker, _ := newDiscoveryBridgeTestRouter()

	tests := []struct {
		name   string
		token  string
		origin string
		status int
	}{
		{name: "missing", status: http.StatusUnauthorized},
		{name: "public API key is not bridge token", token: "public-api-key", status: http.StatusUnauthorized},
		{name: "wrong", token: bridgeTestToken + "x", status: http.StatusUnauthorized},
		{name: "cross origin", token: bridgeTestToken, origin: "https://attacker.example", status: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/bridge/events", nil)
			if test.token != "" {
				request.Header.Set("Authorization", "Bearer "+test.token)
			}
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), bridgeTestToken) {
				t.Fatal("bridge response leaked its token")
			}
		})
	}
	if broker.Available() {
		t.Fatal("unauthorized requests registered an executor")
	}
}

func TestDiscoveryBridgeEnforcesSingleExecutor(t *testing.T) {
	router, broker, _ := newDiscoveryBridgeTestRouter()
	connection, err := broker.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Disconnect(connection)

	request := authorizedBridgeRequest(http.MethodGet, "/api/bridge/events", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestDiscoveryBridgeCompletesWithRedactedPublicResult(t *testing.T) {
	router, broker, svc := newDiscoveryBridgeTestRouter()
	connection, err := broker.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Disconnect(connection)

	job, err := svc.Create(context.Background(), discovery.CreateDiscoveryInput{
		URL:  "https://example.com/watch",
		Mode: discovery.ModeBrowser,
	})
	if err != nil {
		t.Fatal(err)
	}
	<-connection.Commands

	startResponse := performBridgeRequest(t, router, http.MethodPost, "/api/bridge/discoveries/"+job.ID+"/start", nil)
	if startResponse.Code != http.StatusOK {
		t.Fatalf("start status = %d, body = %s", startResponse.Code, startResponse.Body.String())
	}

	body := map[string]any{
		"sources": []map[string]any{{
			"id":         "source-1",
			"url":        "https://cdn.example.com/master.m3u8",
			"pageUrl":    "https://example.com/watch",
			"title":      "Example",
			"type":       "m3u8",
			"detectedAt": "2026-08-26T12:00:00Z",
			"headers": []string{
				"Cookie: sentinel-cookie",
				"Authorization: Bearer sentinel-authorization",
				"Referer: https://example.com/watch",
			},
		}},
		"partial": false,
	}
	completeResponse := performBridgeRequest(
		t,
		router,
		http.MethodPost,
		"/api/bridge/discoveries/"+job.ID+"/complete",
		body,
	)
	if completeResponse.Code != http.StatusOK {
		t.Fatalf("complete status = %d, body = %s", completeResponse.Code, completeResponse.Body.String())
	}
	raw := completeResponse.Body.String()
	for _, forbidden := range []string{"sentinel-cookie", "sentinel-authorization", "headers", "Headers"} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("public completion leaked %q: %s", forbidden, raw)
		}
	}

	stored, err := svc.Get(job.ID)
	if err != nil || stored.Status != discovery.StatusCompleted || len(stored.Sources) != 1 {
		t.Fatalf("stored job = %+v, %v", stored, err)
	}
	headers, ok := svc.PrivateHeaders(job.ID, "source-1")
	if !ok || len(headers) != 3 {
		t.Fatalf("private headers = %v, %v", headers, ok)
	}
}

func TestDiscoveryBridgeLimitsBodiesAndIgnoresUntrustedFailureMessages(t *testing.T) {
	router, broker, svc := newDiscoveryBridgeTestRouter()
	connection, err := broker.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Disconnect(connection)

	job, err := svc.Create(context.Background(), discovery.CreateDiscoveryInput{URL: "https://example.com/watch"})
	if err != nil {
		t.Fatal(err)
	}
	<-connection.Commands
	if response := performBridgeRequest(t, router, http.MethodPost, "/api/bridge/discoveries/"+job.ID+"/start", nil); response.Code != http.StatusOK {
		t.Fatalf("start status = %d", response.Code)
	}

	failure := map[string]any{
		"errorCode": "discovery_navigation_failed",
		"error":     "Cookie: sentinel-cookie",
	}
	response := performBridgeRequest(t, router, http.MethodPost, "/api/bridge/discoveries/"+job.ID+"/fail", failure)
	if response.Code != http.StatusOK {
		t.Fatalf("failure status = %d, body = %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "sentinel-cookie") {
		t.Fatalf("failure response leaked untrusted details: %s", response.Body.String())
	}
	failed, _ := svc.Get(job.ID)
	if failed.Error != "browser navigation failed" {
		t.Fatalf("stored safe error = %q", failed.Error)
	}

	oversizedPayload := append([]byte(`{"sources":[],"padding":"`), bytes.Repeat([]byte("x"), MaxDiscoveryBridgeBodyBytes)...)
	oversizedPayload = append(oversizedPayload, []byte(`"}`)...)
	oversized := bytes.NewReader(oversizedPayload)
	oversizedRequest := authorizedBridgeRequest(http.MethodPost, "/api/bridge/discoveries/"+job.ID+"/complete", oversized)
	oversizedResponse := httptest.NewRecorder()
	router.ServeHTTP(oversizedResponse, oversizedRequest)
	if oversizedResponse.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d, body = %s", oversizedResponse.Code, oversizedResponse.Body.String())
	}
}

func TestDiscoveryBridgeRejectsHeaderControlCharacters(t *testing.T) {
	router, _, _ := newDiscoveryBridgeTestRouter()
	response := performBridgeRequest(t, router, http.MethodPost, "/api/bridge/discoveries/job-1/complete", map[string]any{
		"sources": []map[string]any{{
			"id":         "source-1",
			"url":        "https://cdn.example.com/master.m3u8",
			"pageUrl":    "https://example.com/watch",
			"title":      "Example",
			"type":       "m3u8",
			"detectedAt": "2026-08-26T12:00:00Z",
			"headers":    []string{"X-Test: safe\x00unsafe"},
		}},
	})
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "discovery_bridge_invalid_source") {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func newDiscoveryBridgeTestRouter() (*gin.Engine, *discovery.Broker, *discovery.Service) {
	gin.SetMode(gin.TestMode)
	broker := discovery.NewBroker()
	svc := discovery.NewService(discovery.NewStore(discovery.StoreOptions{Capacity: 20}), nil, broker)
	handler := NewDiscoveryBridgeHandler(bridgeTestToken, broker, svc)
	router := gin.New()
	router.GET("/api/bridge/events", handler.Events)
	router.POST("/api/bridge/discoveries/:id/start", handler.Start)
	router.POST("/api/bridge/discoveries/:id/complete", handler.Complete)
	router.POST("/api/bridge/discoveries/:id/fail", handler.Fail)
	return router, broker, svc
}

func authorizedBridgeRequest(method, target string, body *bytes.Reader) *http.Request {
	var request *http.Request
	if body == nil {
		request = httptest.NewRequest(method, target, nil)
	} else {
		request = httptest.NewRequest(method, target, body)
	}
	request.Header.Set("Authorization", "Bearer "+bridgeTestToken)
	request.Header.Set("Content-Type", "application/json")
	return request
}

func performBridgeRequest(t *testing.T, router http.Handler, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request := authorizedBridgeRequest(method, target, reader)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
