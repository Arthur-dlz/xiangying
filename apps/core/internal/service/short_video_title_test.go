package service

import "testing"

func TestNormalizeShortVideoDownloadTitleTikTok(t *testing.T) {
	result, ok := normalizeShortVideoDownloadTitle(
		"Example TikTok post https://vm.tiktok.com/example | TikTok",
		"https://www.tiktok.com/@creator/video/7480123456789012345?lang=en",
	)
	if !ok {
		t.Fatal("normalizeShortVideoDownloadTitle() did not recognize TikTok")
	}
	if result.name != "@creator · Example TikTok post" {
		t.Fatalf("name = %q", result.name)
	}
	if result.statusID != "7480123456789012345" {
		t.Fatalf("statusID = %q", result.statusID)
	}
}

func TestNormalizeShortVideoDownloadTitleDouyin(t *testing.T) {
	result, ok := normalizeShortVideoDownloadTitle(
		"示例抖音作品 https://v.douyin.com/iF123AbC/ - 抖音",
		"https://www.douyin.com/video/7480123456789012345?previous_page=web_code_link",
	)
	if !ok {
		t.Fatal("normalizeShortVideoDownloadTitle() did not recognize Douyin")
	}
	if result.name != "抖音 · 示例抖音作品" {
		t.Fatalf("name = %q", result.name)
	}
	if result.statusID != "7480123456789012345" {
		t.Fatalf("statusID = %q", result.statusID)
	}
}

func TestNormalizeShortVideoDownloadTitleShareLinkFallbacks(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want string
	}{
		{
			name: "tiktok",
			url:  "https://vm.tiktok.com/ZTR45GpSF/",
			want: "TikTok video",
		},
		{
			name: "douyin",
			url:  "https://v.douyin.com/iF123AbC/",
			want: "抖音视频",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, ok := normalizeShortVideoDownloadTitle(test.url, test.url)
			if !ok {
				t.Fatal("normalizeShortVideoDownloadTitle() did not recognize share link")
			}
			if result.name != test.want {
				t.Fatalf("name = %q, want %q", result.name, test.want)
			}
		})
	}
}

func TestNormalizeShortVideoDownloadTitleRejectsUnsupportedRoutes(t *testing.T) {
	for _, url := range []string{
		"https://www.tiktok.com/@creator/live",
		"https://www.douyin.com/user/example",
		"https://example.com/video/7480123456789012345",
	} {
		if _, ok := normalizeShortVideoDownloadTitle("Example", url); ok {
			t.Fatalf("normalizeShortVideoDownloadTitle() recognized %q", url)
		}
	}
}

func TestAddDownloadTasksDisambiguatesTikTokTitlesWithPostID(t *testing.T) {
	service, _ := newTestDownloadTaskService(t)
	videos, err := service.AddDownloadTasks([]*AddDownloadTaskInput{
		{
			Name: "Same post",
			URL:  "https://www.tiktok.com/@creator/video/1111111123456789",
		},
		{
			Name: "Same post",
			URL:  "https://www.tiktok.com/@creator/video/2222222298765432",
		},
	})
	if err != nil {
		t.Fatalf("AddDownloadTasks() error = %v", err)
	}

	want := []string{
		"@creator · Same post",
		"@creator · Same post [98765432]",
	}
	for index, video := range videos {
		if video.Name != want[index] {
			t.Fatalf("videos[%d].Name = %q, want %q", index, video.Name, want[index])
		}
	}
}
