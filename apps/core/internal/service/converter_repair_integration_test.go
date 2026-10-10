package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConverterRepairActualFFmpeg(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve integration test source path")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../.."))
	ffmpegPath := os.Getenv("MEDIAGO_REPAIR_FFMPEG")
	if ffmpegPath == "" {
		for _, candidate := range []string{
			filepath.Join(repoRoot, ".deps", "win32-x64", "ffmpeg.exe"),
			filepath.Join(repoRoot, "apps", "electron", "release-slim", "win-unpacked", "resources", "deps", "ffmpeg.exe"),
		} {
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
				ffmpegPath = candidate
				break
			}
		}
	}
	if ffmpegPath == "" {
		t.Skip("set MEDIAGO_REPAIR_FFMPEG or provide the repository FFmpeg bundle for real conversion acceptance")
	}
	ffmpegPath, err := filepath.Abs(ffmpegPath)
	if err != nil {
		t.Fatalf("resolve FFmpeg path: %v", err)
	}
	if info, err := os.Stat(ffmpegPath); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("FFmpeg binary %q is unavailable or not a regular file: %v", ffmpegPath, err)
	}

	samplePath := filepath.Join(repoRoot, "tests", "media-service", "public", "v1", "sample.mp4")
	sampleHash, err := sha256File(samplePath)
	if err != nil {
		t.Fatalf("hash source sample: %v", err)
	}
	evidenceRoot := os.Getenv("MEDIAGO_REPAIR_EVIDENCE_DIR")
	if evidenceRoot == "" {
		evidenceRoot = t.TempDir()
	}
	runDir, err := os.MkdirTemp(evidenceRoot, "converter-acceptance-")
	if err != nil {
		t.Fatalf("create isolated conversion evidence directory: %v", err)
	}

	report := map[string]any{
		"ffmpegPath":      ffmpegPath,
		"ffmpegSHA256":    mustSHA256(t, ffmpegPath),
		"samplePath":      samplePath,
		"sampleSHA256":    sampleHash,
		"evidenceRunDir":  runDir,
		"conversionCases": map[string]any{},
	}
	defer func() {
		encoded, marshalErr := json.MarshalIndent(report, "", "  ")
		if marshalErr == nil {
			marshalErr = os.WriteFile(filepath.Join(runDir, "results.json"), append(encoded, '\n'), 0o600)
		}
		if marshalErr != nil {
			t.Errorf("write acceptance evidence: %v", marshalErr)
		}
	}()

	t.Logf("actual FFmpeg: %s (sha256 %s)", ffmpegPath, report["ffmpegSHA256"])
	t.Logf("source sample: %s (sha256 %s)", samplePath, sampleHash)
	t.Logf("isolated acceptance directory: %s", runDir)

	// Same-format conversion must publish beside the copied input without
	// replacing the input; the resulting media must decode through FFmpeg.
	sameFormatDir := filepath.Join(runDir, "same-format")
	if err := os.Mkdir(sameFormatDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sameInput := filepath.Join(sameFormatDir, "sample.mp4")
	if err := copyFile(samplePath, sameInput); err != nil {
		t.Fatalf("copy same-format input: %v", err)
	}
	sameInputHash, err := sha256File(sameInput)
	if err != nil {
		t.Fatal(err)
	}
	sameOutput, err := NewConverter(ffmpegPath).Start(41001, sameInput, "mp4", "medium", nil)
	if err != nil {
		t.Fatalf("same-format Converter.Start: %v", err)
	}
	if want := filepath.Join(sameFormatDir, "sample (1).mp4"); sameOutput != want {
		t.Fatalf("same-format output = %q, want %q", sameOutput, want)
	}
	if got, err := sha256File(sameInput); err != nil || got != sameInputHash {
		t.Fatalf("same-format source changed: sha256=%s err=%v want=%s", got, err, sameInputHash)
	}
	sameOutputHash, err := sha256File(sameOutput)
	if err != nil {
		t.Fatalf("hash same-format output: %v", err)
	}
	if info, err := os.Stat(sameOutput); err != nil || info.Size() == 0 {
		t.Fatalf("same-format output is missing or empty: info=%v err=%v", info, err)
	}
	sameDecode, err := decodeWithFFmpeg(ffmpegPath, sameOutput)
	if err != nil {
		t.Fatalf("decode same-format output: %v", err)
	}
	report["conversionCases"].(map[string]any)["sameFormat"] = map[string]any{
		"inputPath": sameInput, "inputSHA256BeforeAndAfter": sameInputHash,
		"outputPath": sameOutput, "outputSHA256": sameOutputHash,
		"outputBytes": fileSize(t, sameOutput), "decode": sameDecode,
	}
	t.Logf("same-format: source sha256 unchanged %s; output %s sha256 %s (%d bytes); decode exit 0",
		sameInputHash, sameOutput, sameOutputHash, fileSize(t, sameOutput))

	// Create a real MOV container from the copied sample. A pre-existing MP4
	// sentinel at the natural output name must remain byte-for-byte unchanged.
	collisionDir := filepath.Join(runDir, "mov-collision")
	if err := os.Mkdir(collisionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	movSource := filepath.Join(collisionDir, "source.mp4")
	if err := copyFile(samplePath, movSource); err != nil {
		t.Fatalf("copy MOV-generation source: %v", err)
	}
	movInput := filepath.Join(collisionDir, "clip.mov")
	if output, err := runFFmpeg(ffmpegPath, "-y", "-i", movSource, "-map", "0", "-c", "copy", "-f", "mov", movInput); err != nil {
		t.Fatalf("create MOV test input: %v\n%s", err, output)
	}
	movInputHash, err := sha256File(movInput)
	if err != nil {
		t.Fatalf("hash MOV test input: %v", err)
	}
	sentinelPath := filepath.Join(collisionDir, "clip.mp4")
	sentinel := []byte("preserve existing conversion target sentinel\n")
	if err := os.WriteFile(sentinelPath, sentinel, 0o600); err != nil {
		t.Fatal(err)
	}
	sentinelHash, err := sha256File(sentinelPath)
	if err != nil {
		t.Fatal(err)
	}
	movOutput, err := NewConverter(ffmpegPath).Start(41002, movInput, "mp4", "medium", nil)
	if err != nil {
		t.Fatalf("MOV collision Converter.Start: %v", err)
	}
	if want := filepath.Join(collisionDir, "clip (1).mp4"); movOutput != want {
		t.Fatalf("MOV collision output = %q, want %q", movOutput, want)
	}
	if got, err := sha256File(sentinelPath); err != nil || got != sentinelHash {
		t.Fatalf("existing MP4 sentinel changed: sha256=%s err=%v want=%s", got, err, sentinelHash)
	}
	if contents, err := os.ReadFile(sentinelPath); err != nil || !bytes.Equal(contents, sentinel) {
		t.Fatalf("existing MP4 sentinel contents changed: %q err=%v", contents, err)
	}
	if got, err := sha256File(movInput); err != nil || got != movInputHash {
		t.Fatalf("MOV source changed: sha256=%s err=%v want=%s", got, err, movInputHash)
	}
	movOutputHash, err := sha256File(movOutput)
	if err != nil {
		t.Fatalf("hash MOV conversion output: %v", err)
	}
	if info, err := os.Stat(movOutput); err != nil || info.Size() == 0 {
		t.Fatalf("MOV conversion output is missing or empty: info=%v err=%v", info, err)
	}
	movDecode, err := decodeWithFFmpeg(ffmpegPath, movOutput)
	if err != nil {
		t.Fatalf("decode MOV conversion output: %v", err)
	}
	report["conversionCases"].(map[string]any)["movCollision"] = map[string]any{
		"inputPath": movInput, "inputSHA256BeforeAndAfter": movInputHash,
		"outputPath": movOutput, "outputSHA256": movOutputHash,
		"outputBytes": fileSize(t, movOutput), "decode": movDecode,
		"sentinelPath": sentinelPath, "sentinelSHA256BeforeAndAfter": sentinelHash,
		"sentinelContentsPreserved": true,
	}
	t.Logf("MOV collision: input sha256 unchanged %s; sentinel sha256 unchanged %s; output %s sha256 %s (%d bytes); decode exit 0",
		movInputHash, sentinelHash, movOutput, movOutputHash, fileSize(t, movOutput))
}

func decodeWithFFmpeg(ffmpegPath, inputPath string) (map[string]any, error) {
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-err_detect", "explode", "-i", inputPath, "-map", "0", "-f", "null", "-"}
	cmd := exec.Command(ffmpegPath, args...)
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	err := cmd.Run()
	result := map[string]any{
		"binary":   ffmpegPath,
		"args":     args,
		"exitCode": 0,
		"stderr":   strings.TrimSpace(stderr.String()),
	}
	if err != nil {
		result["exitCode"] = -1
		return result, err
	}
	if message := strings.TrimSpace(stderr.String()); message != "" {
		return result, fmt.Errorf("FFmpeg decoder reported errors: %s", message)
	}
	return result, nil
}

func runFFmpeg(ffmpegPath string, args ...string) (string, error) {
	cmd := exec.Command(ffmpegPath, args...)
	output, err := cmd.CombinedOutput()
	return string(output), err
}

func copyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()

	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func mustSHA256(t *testing.T, path string) string {
	t.Helper()
	hash, err := sha256File(path)
	if err != nil {
		t.Fatalf("hash %q: %v", path, err)
	}
	return hash
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %q: %v", path, err)
	}
	return info.Size()
}
