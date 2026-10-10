package core

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateSensitiveHeaderSupport(t *testing.T) {
	tests := []struct {
		name         string
		downloadType DownloadType
		headers      []string
		wantError    bool
	}{
		{name: "cookie", downloadType: TypeM3U8, headers: []string{"Cookie: session=secret"}, wantError: true},
		{name: "cookie2 case and whitespace", downloadType: TypeM3U8, headers: []string{"  cOoKiE2 : secret"}, wantError: true},
		{name: "authorization", downloadType: TypeM3U8, headers: []string{"authorization: Bearer secret"}, wantError: true},
		{name: "proxy authorization", downloadType: TypeM3U8, headers: []string{"Proxy-Authorization: Basic secret"}, wantError: true},
		{name: "api key", downloadType: TypeM3U8, headers: []string{"X-Api-Key: secret"}, wantError: true},
		{name: "api key alias", downloadType: TypeM3U8, headers: []string{"Api-Key: secret"}, wantError: true},
		{name: "auth token", downloadType: TypeM3U8, headers: []string{"X-Auth-Token: secret"}, wantError: true},
		{name: "access token", downloadType: TypeM3U8, headers: []string{"X-Access-Token: secret"}, wantError: true},
		{name: "line break cannot inject credential header", downloadType: TypeM3U8, headers: []string{"Referer: public\r\nCookie: secret"}, wantError: true},
		{name: "referer allowed", downloadType: TypeM3U8, headers: []string{"Referer: https://site.invalid/"}},
		{name: "origin allowed", downloadType: TypeM3U8, headers: []string{"Origin: https://site.invalid"}},
		{name: "user agent allowed", downloadType: TypeM3U8, headers: []string{"User-Agent: mediago"}},
		{name: "custom lookalike header rejected", downloadType: TypeM3U8, headers: []string{"X-Api-Key-Id: public"}, wantError: true},
		{name: "other engine sensitive header rejected", downloadType: TypeMediago, headers: []string{"Authorization: Bearer secret"}, wantError: true},
		{name: "direct api key rejected", downloadType: TypeDirect, headers: []string{"X-Api-Key: dummy"}, wantError: true},
		{name: "bilibili cookie rejected", downloadType: TypeBilibili, headers: []string{"Cookie: dummy"}, wantError: true},
		{name: "youtube auth token rejected", downloadType: TypeYoutube, headers: []string{"X-Auth-Token: dummy"}, wantError: true},
		{name: "xiaohongshu proxy authorization rejected", downloadType: TypeXiaohongshu, headers: []string{"Proxy-Authorization: dummy"}, wantError: true},
		{name: "direct line break rejected", downloadType: TypeDirect, headers: []string{"Referer: public\r\nCookie: dummy"}, wantError: true},
		{name: "unknown type cannot bypass sensitive-header rejection", downloadType: DownloadType("unknown"), headers: []string{"Authorization: dummy"}, wantError: true},
		{name: "unknown type with public header remains policy-allowed", downloadType: DownloadType("unknown"), headers: []string{"Referer: public"}},
		{name: "unknown custom auth header rejected", downloadType: TypeDirect, headers: []string{"X-Private-Session: dummy"}, wantError: true},
		{name: "arbitrary custom header rejected", downloadType: TypeDirect, headers: []string{"X-Debug-Trace: public"}, wantError: true},
		{name: "header without colon rejected", downloadType: TypeDirect, headers: []string{"Cookie"}, wantError: true},
		{name: "empty header name rejected", downloadType: TypeDirect, headers: []string{": value"}, wantError: true},
		{name: "direct public headers allowed", downloadType: TypeDirect, headers: []string{"Referer: https://site.invalid/", "User-Agent: mediago"}},
		{name: "bilibili public headers allowed", downloadType: TypeBilibili, headers: []string{"Origin: https://site.invalid"}},
		{name: "all remaining public header names allowed", downloadType: TypeYoutube, headers: []string{"Accept: */*", "Accept-Language: en", "Accept-Encoding: gzip", "Range: bytes=0-10"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateSensitiveHeaderSupport(test.downloadType, test.headers)
			if test.wantError {
				if !errors.Is(err, ErrSensitiveHeadersUnsupported) {
					t.Fatalf("validateSensitiveHeaderSupport() error = %v, want ErrSensitiveHeadersUnsupported", err)
				}
				for _, value := range []string{"secret", "dummy", "public"} {
					if strings.Contains(err.Error(), value) {
						t.Fatalf("policy error leaked a header value: %v", err)
					}
				}
			} else if err != nil {
				t.Fatalf("validateSensitiveHeaderSupport() error = %v, want nil", err)
			}
		})
	}
}
