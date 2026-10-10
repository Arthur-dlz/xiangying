<p align="center"><img src="assets/brand/dalizi-logo.png" width="160" alt="DALIZI 项目标识"></p>

# 乡映 · Xiangying

**让乡村孩子有机会在一块大屏幕上，看见更广阔的世界。**

乡映是一款面向 Windows 的中文网页媒体嗅探、下载与本地片库工具，基于 [MediaGo](https://github.com/mediago-dev/mediago) 二次开发，服务于乡村活动室、学校及其他需要离线放映的场景。

[English](README.en.md) · [使用说明](docs/xiangying/USAGE.md) · [所有版本](https://github.com/Arthur-dlz/xiangying/releases) · [参与维护](CONTRIBUTING.md) · [后续计划](ROADMAP.md)

## 下载与开始使用

### [⬇ 下载 Windows x64 完整程序（ZIP，约 255 MiB）](https://github.com/Arthur-dlz/xiangying/releases/download/v0.1.0-alpha.3/xiangying-0.1.0-alpha.3-windows-x64-20261010.zip)

当前已发布 **v0.1.0-alpha.3 预发行版**，适用于 Windows 10/11 x64，提供完整目录版。

[查看本版发布说明](https://github.com/Arthur-dlz/xiangying/releases/tag/v0.1.0-alpha.3) · [下载校验文件](https://github.com/Arthur-dlz/xiangying/releases/download/v0.1.0-alpha.3/SHA256SUMS.txt)

1. 点击上面的下载链接，保存完整程序 ZIP。
2. 右键 ZIP，选择“全部解压”，保留整个解压目录。
3. 打开解压后的文件夹，双击 **`乡映.exe`**。`resources`、`locales` 和 DLL 等配套文件需要一起保留。

Releases 中自动生成的 `Source code (zip)` / `Source code (tar.gz)` 是供开发使用的源码；普通使用者请选择上面的完整程序 ZIP。下载、转换目标目前仅支持 **NTFS**。

## 为什么做乡映

这个项目起于一位村支书的求助：想给村里的孩子们放电影，却在找影片、下载和准备放映文件时遇到了困难。购买视频平台会员之后，仍有不少影片无法下载；有的平台离线内容只能在自己的 App 中播放，也难以转移到活动室的电脑和投影设备上。

一次放映需要的不只是一个在线播放链接，还需要能在现场可靠播放的本地文件，以及便于整理、查找和重复使用的片库。对并不熟悉电脑工具的基层工作人员来说，这些准备工作常常耗费很多时间。

我们希望孩子们能接触更多不同国家、文化和题材的电影，在故事中认识更大的世界。乡映从这些具体需求出发，帮助工作人员把**有权下载、保存和放映的影片**整理到本地，再通过电脑、播放器和投影或大屏设备观看。

开源社区已经做出了许多优秀工具。我们选择在 MediaGo 的基础上，围绕中文使用体验、本地片库和离线放映流程进行适配与功能完善，并把改动继续开放给社区。

## 现在可以做什么

- 在内置浏览器中查看网页媒体资源，将可下载的公开媒体加入队列。
- 管理下载、重试与媒体合并，保留明确的成功或失败反馈。
- 导入本地媒体，或将完成的下载同步到“我的片库”；搜索、分类、筛选、播放、打开文件位置及复制导出。
- 转换 MP4/MKV/WebM 和 MP3/AAC/FLAC/WAV，提供三档质量；批量操作覆盖符合条件的跨页任务。
- 保护已有同名文件；删除任务或片库条目时保留媒体文件。

投影、外接大屏或投屏由 Windows、播放器和相应设备完成；乡映负责媒体准备与本地管理。

## 当前状态与使用

项目已经**初步可用，仍处于早期版本，后续持续维护**。当前交付为 `0.1.0-alpha.3`，支持 Windows 10/11 x64，提供完整目录版 ZIP。

本版完整程序已发布，下载链接和解压步骤见上方“下载与开始使用”。正式放映前，建议在实际电脑和放映设备上检查影片能否完整播放。

当前范围内的原 77 项回归合同已闭合：76 项通过、1 项不适用。证据层及适用范围见 [验收摘要](docs/xiangying/ACCEPTANCE.md)。项目尚不承诺所有网站兼容或所有外部影片均可下载。

### 已知范围

- 下载、转换目标目前仅支持 **NTFS**；exFAT/FAT32 目标会明确报错。将已完成媒体复制到 U 盘与直接下载、转换到 U 盘是不同操作。
- 显式填写 Cookie、Authorization 等敏感请求头的任务目前会拒绝；认证下载延期。
- DRM/受保护媒体下载和边下边播不在当前范围。
- 网站的登录要求、访问限制和页面变化可能影响检测与下载。
- 本分支禁用上游自动更新；升级请手动取得新版本完整包。

## 一起把它维护下去

乡映目前由个人维护，欢迎开发者、测试者、教师和基层放映组织者参与。我们需要真实、可复现的问题反馈，中文使用说明的改进，以及更可靠的下载、文件保护和片库体验。

如果你是影片版权方、发行机构或愿意提供支持的组织，也欢迎讨论**适合儿童观看的合法片源、离线使用或放映授权**。能帮助组织者稳定获得影片的授权与合作，对项目同样重要。

代码、测试、文档、维护工具或计算资源方面的支持，也能帮助这个项目持续更新。参与方式见 [贡献指南](CONTRIBUTING.md) 与 [维护和支持](SUPPORT.md)。

## 开源来源与致谢

乡映基于 [MediaGo](https://github.com/mediago-dev/mediago)，沿用其 Electron、React、Go Core 及下载能力，并感谢上游作者与所有贡献者。下载、媒体处理及桌面运行还依赖 FFmpeg、aria2、yt-dlp、Deno、BBDown 等开源项目。

我们保留 MediaGo 的原始版权声明和 [MIT 许可证](LICENSE)，并保留 [第三方声明](THIRD_PARTY_NOTICES.md)。项目来源、继承范围与改动说明见 [NOTICE](NOTICE.md)。源码中的 `@mediago/*` 包名继续保留，避免仅为改名而破坏构建；适合上游复用的修复，也欢迎整理后回馈上游。

请确认影片观看、下载、离线保存与公共放映所需的相应授权，在你拥有相应权利的范围内使用；视频平台会员并不能解决所有文件转移或放映需求。

## 开发与反馈

正式仓库：[Arthur-dlz/xiangying](https://github.com/Arthur-dlz/xiangying)。开发入口与工具链见 [开发说明](docs/xiangying/DEVELOPMENT.md)，普通问题请提交 [Issue](https://github.com/Arthur-dlz/xiangying/issues)。涉及凭据、个人信息或安全漏洞时，先阅读 [安全反馈说明](SECURITY.md)。
