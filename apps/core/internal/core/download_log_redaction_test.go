package core

import (
	"strings"
	"testing"
)

func TestRedactURLsFromDownloaderLogPreservesContextAndRemovesSecrets(t *testing.T) {
	tests := []struct {
		name string
		line string
		want string
	}{
		{
			name: "userinfo encoded query fragment and punctuation",
			line: "errorCode=22 URI=https://user:pass@example.test/path?token=secret%2Fvalue#fragment.",
			want: "errorCode=22 URI=https://example.test/path.",
		},
		{
			name: "multiple URLs",
			line: "request failed source=https://example.test/a?key=one target=http://other.test/b#part; retry=1",
			want: "request failed source=https://example.test/a target=http://other.test/b; retry=1",
		},
		{
			name: "malformed authority fails closed",
			line: "exception URI=http://[broken?token=sentinel",
			want: "exception URI=http://[REDACTED]",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := redactURLsFromDownloaderLog(test.line)
			if got != test.want {
				t.Fatalf("redactURLsFromDownloaderLog() = %q, want %q", got, test.want)
			}
			if strings.Contains(got, "secret") || strings.Contains(got, "sentinel") || strings.Contains(got, "user:pass") {
				t.Fatalf("redacted output retained secret material: %q", got)
			}
		})
	}
}
