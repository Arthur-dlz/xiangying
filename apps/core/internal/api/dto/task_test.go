package dto

import (
	"testing"

	"caorushizi.cn/mediago/internal/core"
)

func TestCreateTaskReqInfersTypeWhenOmitted(t *testing.T) {
	urls := []string{
		"https://x.com/mediago/status/1234567890",
		"https://www.tiktok.com/@creator/video/7480123456789012345",
		"https://www.douyin.com/video/7480123456789012345",
	}
	for _, taskURL := range urls {
		req := CreateTaskReq{URL: taskURL, Name: "social-video"}
		if got := req.ToDownloadParams().Type; got != core.TypeYoutube {
			t.Fatalf("ToDownloadParams(%q).Type = %q, want %q", taskURL, got, core.TypeYoutube)
		}
	}
}

func TestCreateTaskReqPreservesExplicitType(t *testing.T) {
	req := CreateTaskReq{
		Type: core.TypeDirect,
		URL:  "https://x.com/mediago/status/1234567890",
		Name: "x-video",
	}
	if got := req.ToDownloadParams().Type; got != core.TypeDirect {
		t.Fatalf("ToDownloadParams().Type = %q, want %q", got, core.TypeDirect)
	}
}
