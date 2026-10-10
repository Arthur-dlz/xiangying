# 参与乡映

感谢你愿意帮助乡映。我们希望给乡村孩子组织电影放映的工作人员，能更方便地准备和管理有权使用的本地影片。项目目前初步可用，仍需要持续维护。

## 不写代码也可以参与

- 反馈使用中的困难，描述复现步骤、Windows版本和乡映版本。
- 改进中文说明，帮助不熟悉电脑的使用者完成下载、片库管理和放映准备。
- 在自己的 Windows 和放映设备上测试，反馈文件保护、失败提示和播放体验。
- 联系合法片源或影片放映授权合作；请不要上传影片本体或他人的私人聊天记录。

反馈入口：[Issues](https://github.com/Arthur-dlz/xiangying/issues)。请移除 Cookie、Authorization、私人链接和个人目录信息。

## 开发

```powershell
git clone https://github.com/Arthur-dlz/xiangying.git
cd xiangying
task doctor
task deps:install
task dev:electron
```

工具链版本与构建说明见 [开发说明](docs/xiangying/DEVELOPMENT.md)。维护重点是 Windows 桌面主链路。内部 workspace 及 `@mediago/*` 名称继承自 MediaGo；保持依赖锁定和上游声明。

## 提交改动

针对 `main` 提交 Pull Request。先描述实际问题，再说明改动后的行为和对应验证。每个 PR 尽量只解决一个明确问题；功能语义、授权范围或依赖变化较大时，先开 Issue 讨论。

修复需要相关回归证据。单元、模拟、实际程序运行和真实设备测试请分开说明，不把一次通过外推成全部网站或设备兼容。不要使用真实凭据、私人配置或未经授权媒体作为测试夹具。

请保留既有用户文件，不引入静默覆盖；不得默认扩大敏感请求头传递、远程网页权限或更新来源。维护计划见 [ROADMAP](ROADMAP.md)。

尊重 MediaGo 和其他上游项目的许可、作者与贡献者。通用问题可以同时整理为上游适用的修复，提交前先检查上游版本是否已解决。
