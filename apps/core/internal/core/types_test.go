package core

import "testing"

func TestInferDownloadType(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want DownloadType
	}{
		{name: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD", want: TypeBilibili},
		{name: "bilibili short link", url: "https://b23.tv/example", want: TypeBilibili},
		{name: "youtube", url: "https://www.youtube.com/watch?v=example", want: TypeYoutube},
		{name: "youtube short link", url: "https://youtu.be/example", want: TypeYoutube},
		{name: "x status", url: "https://x.com/mediago/status/1234567890?s=20", want: TypeYoutube},
		{name: "twitter status suffix", url: "https://mobile.twitter.com/mediago/status/1234567890/video/1", want: TypeYoutube},
		{name: "x home is not downloadable", url: "https://x.com/home", want: TypeDirect},
		{name: "x non-numeric status is not downloadable", url: "https://x.com/mediago/status/latest", want: TypeDirect},
		{name: "tiktok video", url: "https://www.tiktok.com/@creator/video/7480123456789012345", want: TypeYoutube},
		{name: "tiktok mobile video", url: "https://m.tiktok.com/@creator/video/7480123456789012345", want: TypeYoutube},
		{name: "tiktok share video", url: "https://www.tiktok.com/share/video/7480123456789012345", want: TypeYoutube},
		{name: "tiktok short link", url: "https://vm.tiktok.com/ZTR45GpSF/", want: TypeYoutube},
		{name: "douyin video", url: "https://www.douyin.com/video/7480123456789012345", want: TypeYoutube},
		{name: "douyin short link", url: "https://v.douyin.com/iF123AbC/", want: TypeYoutube},
		{name: "tiktok live is not downloadable", url: "https://www.tiktok.com/@creator/live", want: TypeDirect},
		{name: "douyin profile is not downloadable", url: "https://www.douyin.com/user/example", want: TypeDirect},
		{name: "xiaohongshu explore note", url: "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=token", want: TypeXiaohongshu},
		{name: "xiaohongshu discovery note", url: "https://www.xiaohongshu.com/discovery/item/66f00abc1234567890abcdef?xsec_token=token", want: TypeXiaohongshu},
		{name: "xiaohongshu profile note", url: "https://www.xiaohongshu.com/user/profile/5abc1234567890abcdef1234/66f00abc1234567890abcdef?xsec_token=token", want: TypeXiaohongshu},
		{name: "xiaohongshu short link", url: "https://xhslink.com/a1B2c3D4", want: TypeXiaohongshu},
		{name: "xiaohongshu explore feed is not downloadable", url: "https://www.xiaohongshu.com/explore", want: TypeDirect},
		{name: "hls", url: "https://cdn.example.com/path/master.m3u8?token=secret", want: TypeM3U8},
		{name: "direct", url: "https://cdn.example.com/video.mp4", want: TypeDirect},
		{name: "invalid", url: "://bad-url", want: TypeDirect},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := InferDownloadType(test.url); got != test.want {
				t.Fatalf("InferDownloadType(%q) = %q, want %q", test.url, got, test.want)
			}
		})
	}
}
