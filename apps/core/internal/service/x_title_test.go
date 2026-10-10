package service

import (
	"strings"
	"testing"
)

func TestNormalizeXDownloadTitleCleansPageWrapperAndURL(t *testing.T) {
	result, ok := normalizeXDownloadTitle(
		`(1) X 上的 Yadong Xie：“最近一直在探索 agent 借助 web 技术来表达场景交互的界限在哪里，最后得到的答案是没有界限，光棱坦克启动！ https://t.co/hcutxltqvn” — X`,
		"https://x.com/yadong_xie/status/2092623470630973826?s=20",
	)
	if !ok {
		t.Fatal("normalizeXDownloadTitle() did not recognize an X status URL")
	}
	if result.statusID != "2092623470630973826" {
		t.Fatalf("statusID = %q", result.statusID)
	}
	if !strings.HasPrefix(result.name, "@yadong_xie · 最近一直在探索 agent") {
		t.Fatalf("name = %q", result.name)
	}
	for _, unwanted := range []string{"(1)", "X 上的", "Yadong Xie", "https", "t.co", "— X"} {
		if strings.Contains(result.name, unwanted) {
			t.Fatalf("name %q contains %q", result.name, unwanted)
		}
	}
	if !strings.HasSuffix(result.name, "…") {
		t.Fatalf("name = %q, want truncation ellipsis", result.name)
	}
	if len(result.name) > maxSocialTitleBytes {
		t.Fatalf("name byte length = %d, want <= %d", len(result.name), maxSocialTitleBytes)
	}
}

func TestNormalizeXDownloadTitleKeepsShortText(t *testing.T) {
	result, ok := normalizeXDownloadTitle(
		"New model today!",
		"https://twitter.com/openai/status/1234567890",
	)
	if !ok {
		t.Fatal("normalizeXDownloadTitle() did not recognize a Twitter status URL")
	}
	if result.name != "@openai · New model today!" {
		t.Fatalf("name = %q", result.name)
	}
}

func TestNormalizeXDownloadTitleUsesReadableFallback(t *testing.T) {
	result, ok := normalizeXDownloadTitle(
		" https://t.co/video ",
		"https://x.com/mediago/status/1234567890",
	)
	if !ok {
		t.Fatal("normalizeXDownloadTitle() did not recognize an X status URL")
	}
	if result.name != "@mediago · X video" {
		t.Fatalf("name = %q", result.name)
	}
}

func TestNormalizeXDownloadTitleRejectsNonStatusURL(t *testing.T) {
	if _, ok := normalizeXDownloadTitle("Example", "https://example.com/video"); ok {
		t.Fatal("normalizeXDownloadTitle() recognized a non-X URL")
	}
	if _, ok := normalizeXDownloadTitle("Example", "https://x.com/home"); ok {
		t.Fatal("normalizeXDownloadTitle() recognized a non-status X URL")
	}
}

func TestAddDownloadTaskNormalizesXTitle(t *testing.T) {
	service, _ := newTestDownloadTaskService(t)
	video, err := service.AddDownloadTask(&AddDownloadTaskInput{
		Name: `(1) X 上的 MediaGo：“这是一条简短的视频更新 https://t.co/abc123” — X`,
		URL:  "https://x.com/mediago/status/1234567890",
	})
	if err != nil {
		t.Fatalf("AddDownloadTask() error = %v", err)
	}
	if video.Name != "@mediago · 这是一条简短的视频更新" {
		t.Fatalf("stored name = %q", video.Name)
	}
}

func TestAddDownloadTasksDisambiguatesNormalizedXTitlesWithStatusID(t *testing.T) {
	service, _ := newTestDownloadTaskService(t)
	videos, err := service.AddDownloadTasks([]*AddDownloadTaskInput{
		{
			Name: "Same update",
			URL:  "https://x.com/mediago/status/1111111123456789",
		},
		{
			Name: "Same update",
			URL:  "https://x.com/mediago/status/2222222298765432",
		},
	})
	if err != nil {
		t.Fatalf("AddDownloadTasks() error = %v", err)
	}
	want := []string{
		"@mediago · Same update",
		"@mediago · Same update [98765432]",
	}
	for index, video := range videos {
		if video.Name != want[index] {
			t.Fatalf("videos[%d].Name = %q, want %q", index, video.Name, want[index])
		}
	}
}
