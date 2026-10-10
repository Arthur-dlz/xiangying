# 开发说明

Windows 桌面主链路位于 apps/electron、apps/ui 和 apps/core；共享类型与构建工具位于 packages。

## 工具链

- Node.js 24.14.0 或更新版本（项目 doctor 最低要求）。
- pnpm 11.23.0，使用 package.json 的 packageManager 与现有 pnpm-lock.yaml。
- Go 1.25.0，见 go.work 和 apps/core/go.mod。
- Task：使用 packages/tooling/src/bootstrap 和 task-version-gate 的版本校验。

在已具备对应工具的 Windows 主机，从仓库根目录执行：

```powershell
task doctor
task deps:install
task dev:electron
```

`task build:electron` 构建桌面工作区；`task pack:electron` 生成目录版。依赖安装/准备可能访问网络、下载固定版本工具，步骤由 Taskfile.yml 控制。发布不是构建的前置步骤，不需要使用上游仓库凭据。

.env 已设置 APP_NAME=xiangying 和独立 APP_ID。没有在本次整理中替换依赖、内部包名或构建实现。当前程序 ZIP 是此前验收候选的逐文件复制；未在干净导出目录再次安装/构建，不声称已经验证跨机器或逐位可复现构建。

## 测试

使用 Taskfile.yml 中的 test、check 和各域入口。普通单元测试可按文件定向执行。历史 Windows 打包回归 harness 中部分用例依赖本机候选绑定和 .task 证据目录；这些运行数据不公开打包，需要为新的环境准备隔离夹具及绑定，不能直接把历史 harness 结果当作新机器验收。

上游 docs/、Docker/Web/扩展工具仍保留以维持 workspace 结构；乡映当前交付的支持范围以根 README 和 docs/xiangying 为准。
