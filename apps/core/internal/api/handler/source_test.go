package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"caorushizi.cn/mediago/internal/service"
	"github.com/gin-gonic/gin"
)

type sourceHandlerTestConfig struct{}

func (sourceHandlerTestConfig) Get(string) any { return nil }

func TestSourceHandlerInspectsBatchWithoutCreatingTasks(t *testing.T) {
	gin.SetMode(gin.TestMode)
	playlistServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
video-1080.m3u8
`))
	}))
	defer playlistServer.Close()

	handler := NewSourceHandler(service.NewM3U8Inspector(sourceHandlerTestConfig{}))
	engine := gin.New()
	engine.POST("/api/sources/inspect", handler.Inspect)
	body, err := json.Marshal(map[string]any{
		"sources": []map[string]any{{
			"id": "source-1", "url": playlistServer.URL + "/signed/play?id=1",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/sources/inspect", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Data struct {
			Sources []service.SourceInspection `json:"sources"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Data.Sources) != 1 || response.Data.Sources[0].MaxQuality != "1080p" {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestSourceHandlerRejectsOversizedInspectionBody(t *testing.T) {
	handler := NewSourceHandler(service.NewM3U8Inspector(sourceHandlerTestConfig{}))
	engine := gin.New()
	engine.POST("/api/sources/inspect", handler.Inspect)
	body := `{"sources":[{"id":"source-1","url":"https://example.com/play","headers":["X-Large: ` + strings.Repeat("x", maxInspectRequestBodyBytes) + `"]}]}`
	request := httptest.NewRequest(http.MethodPost, "/api/sources/inspect", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}
