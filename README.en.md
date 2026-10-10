<p align="center"><img src="assets/brand/dalizi-logo.png" width="160" alt="DALIZI project identity"></p>

# Xiangying · 乡映

**Helping rural children discover a wider world through cinema.**

[中文](README.md) · [Repository](https://github.com/Arthur-dlz/xiangying) · [Releases](https://github.com/Arthur-dlz/xiangying/releases)

## Download and run

### [⬇ Download the complete Windows x64 application (ZIP, about 255 MiB)](https://github.com/Arthur-dlz/xiangying/releases/download/v0.1.0-alpha.3/xiangying-0.1.0-alpha.3-windows-x64-20261010.zip)

**v0.1.0-alpha.3 is available as a prerelease** for Windows 10/11 x64.

[Release notes](https://github.com/Arthur-dlz/xiangying/releases/tag/v0.1.0-alpha.3) · [Checksums](https://github.com/Arthur-dlz/xiangying/releases/download/v0.1.0-alpha.3/SHA256SUMS.txt)

1. Download the complete application ZIP above.
2. Extract the entire ZIP into a folder.
3. Run **`乡映.exe`**, keeping `resources`, `locales` and all companion files in place.

GitHub's automatic `Source code (zip)` / `Source code (tar.gz)` assets are for development. End users should choose the complete application ZIP. Download/conversion destinations currently require **NTFS**.

Xiangying is a Chinese-language Windows desktop tool for detecting downloadable web media, managing downloads and organizing a local media library. It is derived from [MediaGo](https://github.com/mediago-dev/mediago).

The project began with a request from a village community organizer who wanted to show films to children. Even after purchasing a streaming subscription, some films could not be downloaded, and app-bound offline viewing did not reliably provide files usable on the community computer and projector.

Our aim is to make it easier to prepare and organize films that the organizer has permission to download, store and screen, so children can encounter stories from different countries and cultures. Playback on a projector or large screen uses Windows, a media player and the available display equipment. The project does not supply films or screening rights.

## Status

An individually maintained project with an initially usable Windows x64 alpha (`0.1.0-alpha.3`). Ongoing maintenance remains necessary. The scoped 77-item regression contract closed with 76 passes and one not-applicable item; evidence includes separately identified unit, controlled runtime, native and historical layers. This is not universal website or device compatibility certification. See [acceptance summary](docs/xiangying/ACCEPTANCE.md).

## Capabilities and scope

Download queues, retry and merging; local library import, search, categorization and export; media conversion; collision-safe outputs; cross-page conversion actions; task/index removal that preserves media files.

Download/conversion destinations currently require NTFS. Tasks with explicit sensitive request headers are rejected. Authenticated/protected-media downloads and playback during downloading are deferred. Upstream automatic updates are disabled in this derivative. Extract the entire Windows ZIP and run `乡映.exe`, retaining all companion files.

## Contributing and support

Help is welcome with reproducible bug reports, Windows testing, Chinese documentation, security review and maintenance. We also welcome conversations with rights holders about child-appropriate films and offline/screening permissions. See [CONTRIBUTING](CONTRIBUTING.md), [ROADMAP](ROADMAP.md) and [SUPPORT](SUPPORT.md).

## Attribution

We retain MediaGo's copyright and [MIT license](LICENSE), acknowledge its authors and contributors, and preserve the licenses and notices of bundled tools. See [NOTICE](NOTICE.md) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md). The project does not claim sole authorship of the inherited implementation. General fixes suitable for upstream reuse are welcome.
