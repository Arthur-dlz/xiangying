# External downloader output contracts

These fixtures pin the console-output contracts for the downloader versions in
[`packages/tooling/manifests/runtime-deps.json`](../../../../../../packages/tooling/manifests/runtime-deps.json):

- BBDown `1.6.3`
- yt-dlp `2026.08.19`

Each JSON array element represents exactly one chunk delivered to a Runner
callback. Contract tests trim and parse each element independently; they do not
join, split, or otherwise rechunk the captured output.

MediaGo's production runtime injects `PTYRunner`. On Unix/macOS, a successful
`pty.Start` keeps BBDown's terminal output enabled, and `readPTYOutput` forwards
its raw bytes as callback chunks. Only PTY startup failure uses the `StdoutPipe`
fallback, where this terminal progress is not guaranteed.

The fixture text uses synthetic identifiers while preserving the output shapes
defined by the pinned upstream sources:

| Fixture                           | Official tagged source                                                                                                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bbdown-progress.json`            | BBDown 1.6.3 [`ProgressBar.cs`](https://github.com/nilaoda/BBDown/blob/1.6.3/BBDown/ProgressBar.cs), [`Program.cs`](https://github.com/nilaoda/BBDown/blob/1.6.3/BBDown/Program.cs), and [`BBDownUtil.cs`](https://github.com/nilaoda/BBDown/blob/1.6.3/BBDown/BBDownUtil.cs) |
| `bbdown-failure.json`             | BBDown 1.6.3 [`Program.cs`](https://github.com/nilaoda/BBDown/blob/1.6.3/BBDown/Program.cs) and [`Logger.cs`](https://github.com/nilaoda/BBDown/blob/1.6.3/BBDown.Core/Logger.cs)                                                                                             |
| `yt-dlp-progress.json`            | yt-dlp 2026.08.19 [`downloader/common.py`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/downloader/common.py) and [`YoutubeDL.py`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/YoutubeDL.py)                                                           |
| `yt-dlp-error.json`               | yt-dlp 2026.08.19 [`YoutubeDL.py`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/YoutubeDL.py)                                                                                                                                                                      |
| `yt-dlp-douyin-cookie-error.json` | yt-dlp 2026.08.19 [`tiktok.py`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/tiktok.py)                                                                                                                                                                  |
