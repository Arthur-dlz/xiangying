package core

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"caorushizi.cn/mediago/internal/core/schema"
)

type observedHLSRequest struct {
	path          string
	cookie        bool
	authorization bool
}

type dependencyProcessRunner struct {
	calls      int
	lastArgs   []string
	lastOutput string
}

func (runner *dependencyProcessRunner) Run(ctx context.Context, bin string, args []string, onLine func(string)) error {
	runner.calls++
	runner.lastArgs = append([]string(nil), args...)
	output, err := exec.CommandContext(ctx, bin, args...).CombinedOutput()
	runner.lastOutput = string(output)
	if onLine != nil {
		for _, line := range strings.Split(string(output), "\n") {
			onLine(line)
		}
	}
	return err
}

func configureControlledHLSProcessEnv(t *testing.T, outputParent string) {
	t.Helper()
	tempRoot := filepath.Join(outputParent, "tmp")
	appData := filepath.Join(tempRoot, "appdata")
	if err := os.MkdirAll(appData, 0o700); err != nil {
		t.Fatal(err)
	}
	// Keep all child temp/profile writes in the task evidence area, and make
	// localhost fixtures bypass any inherited shell proxy configuration.
	t.Setenv("TEMP", tempRoot)
	t.Setenv("TMP", tempRoot)
	t.Setenv("APPDATA", appData)
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		t.Setenv(key, "")
	}
	for _, key := range []string{"NO_PROXY", "no_proxy"} {
		t.Setenv(key, "localhost,127.0.0.1,::1")
	}
}

func verifyFFmpegDecode(ctx context.Context, ffmpeg, mediaPath string) ([]byte, error) {
	return exec.CommandContext(ctx, ffmpeg, "-nostdin", "-v", "error", "-i", mediaPath, "-f", "null", "-").CombinedOutput()
}

func writeOrdinaryHLSFailureEvidence(outputParent string, runner *dependencyProcessRunner, err error) error {
	diagnostic := fmt.Sprintf("error_class: %T\nerrors_is_deadline: %t\nerrors_is_missing_output: %t\nrunner_calls: %d\narguments: %q\nchild_output:\n%s",
		err,
		errors.Is(err, context.DeadlineExceeded),
		errors.Is(err, ErrM3U8OutputMissing),
		runner.calls,
		runner.lastArgs,
		runner.lastOutput,
	)
	return os.WriteFile(filepath.Join(outputParent, "ordinary-hls-diagnostic.txt"), []byte(diagnostic), 0o600)
}

func writeOrdinaryHLSSuccessEvidence(outputParent, dependency, ffmpeg string, runner *dependencyProcessRunner, outputPath string) error {
	dependencyBytes, err := os.ReadFile(dependency)
	if err != nil {
		return err
	}
	ffmpegBytes, err := os.ReadFile(ffmpeg)
	if err != nil {
		return err
	}
	outputBytes, err := os.ReadFile(outputPath)
	if err != nil {
		return err
	}
	diagnostic := fmt.Sprintf(
		"n_m3u8dl_re_sha256: %x\nffmpeg_sha256: %x\noutput_path: %s\noutput_sha256: %x\nrunner_calls: %d\narguments: %q\nchild_output:\n%s",
		sha256.Sum256(dependencyBytes),
		sha256.Sum256(ffmpegBytes),
		outputPath,
		sha256.Sum256(outputBytes),
		runner.calls,
		runner.lastArgs,
		runner.lastOutput,
	)
	return os.WriteFile(filepath.Join(outputParent, "ordinary-hls-success.txt"), []byte(diagnostic), 0o600)
}

func TestDownloadRejectsSensitiveHLSHeadersBeforeNetwork(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the pinned HLS dependency in this checkout is Windows-only")
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve integration test source path")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", ".."))
	dependency := filepath.Join(repoRoot, ".deps", "win32-x64", "N_m3u8DL-RE.exe")
	if _, err := os.Stat(dependency); err != nil {
		t.Fatalf("pinned N_m3u8DL-RE dependency is unavailable at %q: %v", dependency, err)
	}
	ffmpeg := filepath.Join(filepath.Dir(dependency), "ffmpeg.exe")
	if _, err := os.Stat(ffmpeg); err != nil {
		t.Fatalf("pinned ffmpeg dependency is unavailable at %q: %v", ffmpeg, err)
	}

	outputParent := filepath.Join(repoRoot, ".task", "repair-20261006", "security")
	configureControlledHLSProcessEnv(t, outputParent)

	var mu sync.Mutex
	var sourceRequests int
	var targetRequests []observedHLSRequest
	fixtureDir, err := os.MkdirTemp(outputParent, "hls-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(fixtureDir) })
	segmentPath := filepath.Join(fixtureDir, "segment.ts")
	fixtureOutput, fixtureErr := exec.Command(ffmpeg,
		"-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=1",
		"-t", "1", "-an", "-c:v", "mpeg2video", "-f", "mpegts", "-y", segmentPath,
	).CombinedOutput()
	if fixtureErr != nil {
		t.Fatalf("generate local synthetic HLS segment: %v: %s", fixtureErr, fixtureOutput)
	}
	segmentBytes, err := os.ReadFile(segmentPath)
	if err != nil {
		t.Fatal(err)
	}
	recordTarget := func(request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		targetRequests = append(targetRequests, observedHLSRequest{
			path:          request.URL.Path,
			cookie:        request.Header.Get("Cookie") != "",
			authorization: request.Header.Get("Authorization") != "",
		})
	}

	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		recordTarget(request)
		switch request.URL.Path {
		case "/target.m3u8":
			writer.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = writer.Write([]byte("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nsegment.ts\n#EXT-X-ENDLIST\n"))
		case "/segment.ts":
			writer.Header().Set("Content-Type", "video/mp2t")
			_, _ = writer.Write(segmentBytes)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer target.Close()
	targetURL := strings.Replace(target.URL, "127.0.0.1", "localhost", 1)

	source := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		sourceRequests++
		mu.Unlock()
		if request.URL.Path != "/redirect.m3u8" {
			http.NotFound(writer, request)
			return
		}
		http.Redirect(writer, request, targetURL+"/target.m3u8", http.StatusFound)
	}))
	defer source.Close()
	// The hostname changes while both addresses stay loopback, matching the
	// controlled localhost -> 127.0.0.1 regression without external networking.
	sourceURL := strings.Replace(source.URL, "127.0.0.1", "localhost", 1) + "/redirect.m3u8"
	outputDir, err := os.MkdirTemp(outputParent, "download-output-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(outputDir) })

	ensureTestLogger()
	dependencyRunner := &dependencyProcessRunner{}
	downloader := NewDownloader(
		map[DownloadType]string{TypeM3U8: dependency},
		dependencyRunner,
		schema.DefaultSchemas(),
		testDownloaderConfig{localDir: outputDir, desktop: true},
	)
	sensitiveCtx, cancelSensitive := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelSensitive()
	_, err = downloader.Download(sensitiveCtx, DownloadParams{
		ID:          "sensitive-header-redirect",
		Type:        TypeM3U8,
		URL:         sourceURL,
		Name:        "sensitive-header-redirect",
		DownloadDir: outputDir,
		Headers:     []string{"Cookie: session=synthetic-cookie-sentinel", "Authorization: Bearer synthetic-auth-sentinel"},
	}, Callbacks{})

	if !errors.Is(err, ErrSensitiveHeadersUnsupported) {
		t.Error("Download() did not return an explicit unsupported-sensitive-headers error")
	}
	if err != nil && (strings.Contains(err.Error(), "synthetic-cookie-sentinel") || strings.Contains(err.Error(), "synthetic-auth-sentinel") || strings.Contains(err.Error(), sourceURL)) {
		t.Error("Download() error leaked a test credential or source URL")
	}
	if dependencyRunner.calls != 0 {
		t.Errorf("downloader subprocess was called %d times before rejecting unsupported headers; want zero", dependencyRunner.calls)
	}

	mu.Lock()
	if sourceRequests != 0 {
		t.Errorf("source playlist received %d requests; want zero before rejecting unsupported headers", sourceRequests)
	}
	if len(targetRequests) != 0 {
		t.Errorf("cross-origin target received requests before rejection: %+v", targetRequests)
	}
	mu.Unlock()

	// A normal HLS download without credential-like headers remains supported
	// through the same DownloaderSvc and pinned dependency path.
	ordinaryCtx, cancelOrdinary := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelOrdinary()
	ordinaryResult, ordinaryErr := downloader.Download(ordinaryCtx, DownloadParams{
		ID:          "ordinary-hls",
		Type:        TypeM3U8,
		URL:         sourceURL,
		Name:        "ordinary-hls",
		DownloadDir: outputDir,
	}, Callbacks{})
	if ordinaryErr != nil {
		switch {
		case errors.Is(ordinaryErr, context.DeadlineExceeded):
			t.Fatal("ordinary HLS Download() exceeded its bounded test context")
		case errors.Is(ordinaryErr, ErrM3U8OutputMissing):
			t.Fatal("ordinary HLS Download() produced no merged media artifact from the synthetic TS segment")
		default:
			t.Fatalf("ordinary HLS Download() failed with error class %T", ordinaryErr)
		}
	}
	if ordinaryResult.PrimaryPath == "" {
		t.Fatal("ordinary HLS Download() returned no verified primary output path")
	}
	if _, statErr := os.Stat(ordinaryResult.PrimaryPath); statErr != nil {
		t.Fatalf("ordinary HLS primary output is unavailable: %v", statErr)
	}
	decodeCtx, cancelDecode := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelDecode()
	if decodeOutput, decodeErr := verifyFFmpegDecode(decodeCtx, ffmpeg, ordinaryResult.PrimaryPath); decodeErr != nil {
		t.Fatalf("pinned ffmpeg could not decode ordinary HLS output: %v: %s", decodeErr, decodeOutput)
	}
	if dependencyRunner.calls != 1 {
		t.Errorf("runner call count = %d after rejection and ordinary download, want exactly one ordinary invocation", dependencyRunner.calls)
	}

	mu.Lock()
	observedSourceRequests := sourceRequests
	observedTargetRequests := append([]observedHLSRequest(nil), targetRequests...)
	mu.Unlock()
	if observedSourceRequests == 0 {
		t.Error("ordinary HLS download did not reach the source playlist")
	}
	pathsSeen := make(map[string]bool)
	for _, request := range observedTargetRequests {
		pathsSeen[request.path] = true
	}
	for _, requiredPath := range []string{"/target.m3u8", "/segment.ts"} {
		if !pathsSeen[requiredPath] {
			t.Errorf("ordinary HLS download did not request target path %s", requiredPath)
		}
	}
	for _, request := range observedTargetRequests {
		if request.cookie || request.authorization {
			t.Errorf("ordinary HLS request unexpectedly carried credential-like headers: %+v", request)
		}
	}
	if err := writeOrdinaryHLSSuccessEvidence(outputParent, dependency, ffmpeg, dependencyRunner, ordinaryResult.PrimaryPath); err != nil {
		t.Fatalf("write safe ordinary HLS success evidence: %v", err)
	}
}

func TestOrdinaryHLSDownloadSucceedsWithSyntheticMedia(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the pinned HLS dependency in this checkout is Windows-only")
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve integration test source path")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", ".."))
	dependency := filepath.Join(repoRoot, ".deps", "win32-x64", "N_m3u8DL-RE.exe")
	ffmpeg := filepath.Join(filepath.Dir(dependency), "ffmpeg.exe")
	for _, path := range []string{dependency, ffmpeg} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("required pinned dependency is unavailable at %q: %v", path, err)
		}
	}

	outputParent := filepath.Join(repoRoot, ".task", "repair-20261006", "security")
	configureControlledHLSProcessEnv(t, outputParent)

	fixtureDir, err := os.MkdirTemp(outputParent, "ordinary-hls-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(fixtureDir) })
	segmentPath := filepath.Join(fixtureDir, "segment.ts")
	fixtureOutput, fixtureErr := exec.Command(ffmpeg,
		"-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=1",
		"-t", "1", "-an", "-c:v", "mpeg2video", "-f", "mpegts", "-y", segmentPath,
	).CombinedOutput()
	if fixtureErr != nil {
		t.Fatalf("generate local synthetic HLS segment: %v: %s", fixtureErr, fixtureOutput)
	}
	segmentBytes, err := os.ReadFile(segmentPath)
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var sourceRequests int
	var targetRequests []observedHLSRequest
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		targetRequests = append(targetRequests, observedHLSRequest{
			path:          request.URL.Path,
			cookie:        request.Header.Get("Cookie") != "",
			authorization: request.Header.Get("Authorization") != "",
		})
		mu.Unlock()
		switch request.URL.Path {
		case "/target.m3u8":
			writer.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = writer.Write([]byte("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nsegment.ts\n#EXT-X-ENDLIST\n"))
		case "/segment.ts":
			writer.Header().Set("Content-Type", "video/mp2t")
			_, _ = writer.Write(segmentBytes)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer target.Close()
	targetURL := strings.Replace(target.URL, "127.0.0.1", "localhost", 1)
	source := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		sourceRequests++
		mu.Unlock()
		http.Redirect(writer, request, targetURL+"/target.m3u8", http.StatusFound)
	}))
	defer source.Close()
	sourceURL := strings.Replace(source.URL, "127.0.0.1", "localhost", 1) + "/redirect.m3u8"
	outputDir, err := os.MkdirTemp(outputParent, "ordinary-hls-output-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(outputDir) })

	ensureTestLogger()
	runner := &dependencyProcessRunner{}
	downloader := NewDownloader(
		map[DownloadType]string{TypeM3U8: dependency},
		runner,
		schema.DefaultSchemas(),
		testDownloaderConfig{localDir: outputDir, desktop: true},
	)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, downloadErr := downloader.Download(ctx, DownloadParams{
		ID:          "ordinary-hls-diagnostic",
		Type:        TypeM3U8,
		URL:         sourceURL,
		Name:        "ordinary-hls-diagnostic",
		DownloadDir: outputDir,
	}, Callbacks{})
	if downloadErr != nil {
		if err := writeOrdinaryHLSFailureEvidence(outputParent, runner, downloadErr); err != nil {
			t.Errorf("write ordinary HLS diagnostic: %v", err)
		}
		t.Fatalf("ordinary HLS download failed; safe child diagnostic saved under .task/repair-20261006/security")
	}
	if result.PrimaryPath == "" {
		t.Fatal("ordinary HLS download returned no verified primary output path")
	}
	if _, err := os.Stat(result.PrimaryPath); err != nil {
		t.Fatalf("ordinary HLS primary output is unavailable: %v", err)
	}
	decodeCtx, cancelDecode := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelDecode()
	if decodeOutput, decodeErr := verifyFFmpegDecode(decodeCtx, ffmpeg, result.PrimaryPath); decodeErr != nil {
		t.Fatalf("pinned ffmpeg could not decode ordinary HLS output: %v: %s", decodeErr, decodeOutput)
	}
	mu.Lock()
	observedSourceRequests := sourceRequests
	observedTargetRequests := append([]observedHLSRequest(nil), targetRequests...)
	mu.Unlock()
	if observedSourceRequests == 0 || len(observedTargetRequests) == 0 {
		t.Fatal("ordinary HLS test did not reach both source and redirected target")
	}
	for _, request := range observedTargetRequests {
		if request.cookie || request.authorization {
			t.Errorf("ordinary HLS request carried unexpected credentials: %+v", request)
		}
	}
	if err := writeOrdinaryHLSSuccessEvidence(outputParent, dependency, ffmpeg, runner, result.PrimaryPath); err != nil {
		t.Fatalf("write safe ordinary HLS success evidence: %v", err)
	}
}
