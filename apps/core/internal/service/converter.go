package service

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"caorushizi.cn/mediago/internal/logger"
	"caorushizi.cn/mediago/internal/outputpolicy"
)

const maxFFmpegErrorLines = 24

var (
	ffmpegTimeRegex     = regexp.MustCompile(`time=(\d+):(\d+):(\d+)\.(\d+)`)
	ffmpegDurationRegex = regexp.MustCompile(`Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)`)
)

// ProgressCallback is called with the conversion progress (0-100).
type ProgressCallback func(progress int)

// Converter manages ffmpeg conversion processes.
type Converter struct {
	ffmpegBin             string
	mu                    sync.Mutex
	cancels               map[int64]context.CancelFunc
	outputFilesystemCheck func(string) error
}

// NewConverter creates a Converter with the given ffmpeg binary path.
func NewConverter(ffmpegBin string) *Converter {
	return &Converter{
		ffmpegBin:             ffmpegBin,
		cancels:               make(map[int64]context.CancelFunc),
		outputFilesystemCheck: outputpolicy.RequireNTFSOutputDir,
	}
}

// Start begins an ffmpeg conversion. It blocks until the conversion completes or is cancelled.
// The onProgress callback is called periodically with the current progress percentage.
func (c *Converter) Start(id int64, inputPath, outputFormat, quality string, onProgress ProgressCallback) (outputPath string, err error) {
	if c.ffmpegBin == "" {
		return "", fmt.Errorf("ffmpeg binary path not configured")
	}

	// Generate output path: same dir, new extension
	dir := filepath.Dir(inputPath)
	base := strings.TrimSuffix(filepath.Base(inputPath), filepath.Ext(inputPath))
	formatExtension := strings.ToLower(strings.TrimSpace(strings.TrimLeft(outputFormat, ".")))
	if formatExtension == "" || strings.ContainsAny(formatExtension, `/\\`) {
		return "", fmt.Errorf("invalid output format %q", outputFormat)
	}
	checkOutputFilesystem := c.outputFilesystemCheck
	if checkOutputFilesystem == nil {
		checkOutputFilesystem = outputpolicy.RequireNTFSOutputDir
	}
	if err := checkOutputFilesystem(dir); err != nil {
		return "", err
	}
	stagingFile, err := os.CreateTemp(dir, ".mediago-convert-*."+formatExtension)
	if err != nil {
		return "", fmt.Errorf("create conversion staging output: %w", err)
	}
	stagingPath := stagingFile.Name()
	if err := stagingFile.Close(); err != nil {
		_ = os.Remove(stagingPath)
		return "", fmt.Errorf("close conversion staging output: %w", err)
	}
	defer os.Remove(stagingPath)

	// Get input duration for progress calculation
	duration := c.probeDuration(inputPath)

	// Build ffmpeg args from the same normalized format used for the output
	// extension, so values like "MP4"/".mp4"/"MP4 " cannot silently fall
	// through to the stream-copy default.
	args := buildFFmpegArgs(inputPath, stagingPath, formatExtension, quality)

	ctx, cancel := context.WithCancel(context.Background())
	c.mu.Lock()
	c.cancels[id] = cancel
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.cancels, id)
		c.mu.Unlock()
		cancel()
	}()

	cmd := exec.CommandContext(ctx, c.ffmpegBin, args...)

	// ffmpeg writes progress to stderr
	stderr, pipeErr := cmd.StderrPipe()
	if pipeErr != nil {
		return "", fmt.Errorf("failed to get stderr pipe: %w", pipeErr)
	}

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to start ffmpeg: %w", err)
	}

	// Always consume stderr. Leaving it unread can block ffmpeg once the pipe buffer fills.
	scanner := bufio.NewScanner(stderr)
	scanner.Split(scanFFmpegOutput)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	errorLines := make([]string, 0, maxFFmpegErrorLines)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		errorLines = appendRecentLine(errorLines, line)
		if duration > 0 && onProgress != nil {
			if matches := ffmpegTimeRegex.FindStringSubmatch(line); matches != nil {
				h, _ := strconv.Atoi(matches[1])
				m, _ := strconv.Atoi(matches[2])
				s, _ := strconv.Atoi(matches[3])
				elapsed := time.Duration(h)*time.Hour + time.Duration(m)*time.Minute + time.Duration(s)*time.Second
				pct := int(float64(elapsed) / float64(duration) * 100)
				if pct > 100 {
					pct = 100
				}
				onProgress(pct)
			}
		}
	}
	scanErr := scanner.Err()

	if waitErr := cmd.Wait(); waitErr != nil {
		if ctx.Err() == context.Canceled {
			return "", fmt.Errorf("conversion cancelled")
		}
		return "", formatFFmpegFailure(formatExtension, waitErr, errorLines)
	}
	if scanErr != nil {
		return "", fmt.Errorf("failed to read ffmpeg output: %w", scanErr)
	}
	if ctx.Err() != nil {
		return "", fmt.Errorf("conversion cancelled")
	}
	stagingInfo, statErr := os.Stat(stagingPath)
	if statErr != nil {
		return "", fmt.Errorf("ffmpeg did not create a conversion output: %w", statErr)
	}
	if !stagingInfo.Mode().IsRegular() || stagingInfo.Size() == 0 {
		return "", fmt.Errorf("ffmpeg produced an empty conversion output")
	}

	outputPath, err = publishConvertedOutput(stagingPath, dir, base, formatExtension)
	if err != nil {
		return "", err
	}
	return outputPath, nil
}

func publishConvertedOutput(stagingPath, outputDir, baseName, extension string) (string, error) {
	for suffix := 0; ; suffix++ {
		candidateBase := baseName
		if suffix > 0 {
			candidateBase = fmt.Sprintf("%s (%d)", baseName, suffix)
		}
		candidate := filepath.Join(outputDir, candidateBase+"."+extension)
		if err := os.Link(stagingPath, candidate); err == nil {
			return candidate, nil
		} else if !errors.Is(err, os.ErrExist) {
			return "", fmt.Errorf("cannot safely publish conversion output without replacing an existing file: %w", err)
		}
	}
}

// Stop cancels a running conversion.
func (c *Converter) Stop(id int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cancel, ok := c.cancels[id]; ok {
		cancel()
	}
}

// probeDuration uses ffprobe to get the input file duration.
func (c *Converter) probeDuration(inputPath string) time.Duration {
	ffprobe := companionBinaryPath(c.ffmpegBin, "ffprobe")
	if _, err := os.Stat(ffprobe); err == nil {
		cmd := exec.Command(ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inputPath)
		out, cmdErr := cmd.Output()
		if cmdErr == nil {
			if duration := parseSecondsDuration(strings.TrimSpace(string(out))); duration > 0 {
				return duration
			}
		} else {
			logger.Warnf("ffprobe failed for %s: %v", inputPath, cmdErr)
		}
	}

	// Some dependency bundles contain ffmpeg without ffprobe. Reading the input
	// metadata through ffmpeg is fast and still provides the duration.
	cmd := exec.Command(c.ffmpegBin, "-hide_banner", "-i", inputPath)
	out, _ := cmd.CombinedOutput()
	if duration := parseFFmpegDuration(string(out)); duration > 0 {
		return duration
	}

	logger.Warnf("unable to determine media duration for %s", inputPath)
	return 0
}

func companionBinaryPath(binaryPath, binaryName string) string {
	return filepath.Join(filepath.Dir(binaryPath), binaryName+filepath.Ext(binaryPath))
}

func parseSecondsDuration(value string) time.Duration {
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0
	}
	return time.Duration(seconds * float64(time.Second))
}

func parseFFmpegDuration(output string) time.Duration {
	matches := ffmpegDurationRegex.FindStringSubmatch(output)
	if matches == nil {
		return 0
	}

	hours, _ := strconv.Atoi(matches[1])
	minutes, _ := strconv.Atoi(matches[2])
	seconds, err := strconv.ParseFloat(matches[3], 64)
	if err != nil {
		return 0
	}

	return time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute + time.Duration(seconds*float64(time.Second))
}

func appendRecentLine(lines []string, line string) []string {
	if len(lines) == maxFFmpegErrorLines {
		copy(lines, lines[1:])
		lines[len(lines)-1] = line
		return lines
	}
	return append(lines, line)
}

func formatFFmpegFailure(outputFormat string, runErr error, lines []string) error {
	detail := summarizeFFmpegError(lines)
	if isAudioOutputFormat(outputFormat) && strings.Contains(strings.ToLower(detail), "output file does not contain any stream") {
		return fmt.Errorf("source file has no audio stream")
	}
	if detail != "" {
		return fmt.Errorf("ffmpeg failed: %s", detail)
	}
	return fmt.Errorf("ffmpeg failed: %w", runErr)
}

func summarizeFFmpegError(lines []string) string {
	priorities := []string{
		"output file does not contain any stream",
		"matches no streams",
		"invalid data found",
		"permission denied",
		"no such file or directory",
		"unknown encoder",
		"error",
	}
	for _, priority := range priorities {
		for i := len(lines) - 1; i >= 0; i-- {
			if strings.Contains(strings.ToLower(lines[i]), priority) {
				return lines[i]
			}
		}
	}
	if len(lines) > 0 {
		return lines[len(lines)-1]
	}
	return ""
}

func isAudioOutputFormat(format string) bool {
	switch strings.ToLower(format) {
	case "mp3", "aac", "flac", "wav":
		return true
	default:
		return false
	}
}

// scanFFmpegOutput is a split function for bufio.Scanner that splits on \r or \n.
// ffmpeg uses \r for progress line overwrites.
func scanFFmpegOutput(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i := 0; i < len(data); i++ {
		if data[i] == '\r' || data[i] == '\n' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// buildFFmpegArgs builds the ffmpeg command-line arguments for a given format and quality.
func buildFFmpegArgs(input, output, format, quality string) []string {
	args := []string{"-y", "-i", input}

	switch format {
	case "mp4", "mkv":
		crf := qualityCRF(quality)
		args = append(args, "-c:v", "libx264", "-crf", strconv.Itoa(crf), "-c:a", "aac", "-b:a", "192k")
	case "webm":
		crf := qualityCRF(quality)
		args = append(args, "-c:v", "libvpx-vp9", "-crf", strconv.Itoa(crf), "-b:v", "0", "-c:a", "libopus")
	case "mp3":
		args = append(args, "-vn", "-acodec", "libmp3lame", "-b:a", audioQualityMP3(quality))
	case "aac":
		args = append(args, "-vn", "-acodec", "aac", "-b:a", audioQualityAAC(quality))
	case "flac":
		args = append(args, "-vn", "-acodec", "flac")
	case "wav":
		args = append(args, "-vn", "-acodec", "pcm_s16le")
	default:
		// Fallback: copy streams
		args = append(args, "-c", "copy")
	}

	args = append(args, output)
	return args
}

func qualityCRF(quality string) int {
	switch quality {
	case "high":
		return 18
	case "low":
		return 28
	default:
		return 23
	}
}

func audioQualityMP3(quality string) string {
	switch quality {
	case "high":
		return "320k"
	case "low":
		return "128k"
	default:
		return "192k"
	}
}

func audioQualityAAC(quality string) string {
	switch quality {
	case "high":
		return "256k"
	case "low":
		return "96k"
	default:
		return "128k"
	}
}
