# Windows 本地快速上手（M6）

状态：发布候选（Release Candidate）。本文档面向第一次在 Windows 上安装本工具的用户，只讲"怎么用"，不讲实现细节——实现细节见 `docs/dashboard-*.md` 系列文档。

## 1. 环境要求

* **Node.js 22**（本项目开发/验收使用的版本）。装了多个 Node 版本（比如 Node 22 和 Node 24 并存）容易出现原生模块版本不匹配的问题，遇到相关报错见 `docs/WINDOWS_TROUBLESHOOTING.md`。
* Windows PowerShell 5.1 或 PowerShell 7（`scripts/` 下的脚本两者都支持）。
* 不需要安装 SQLite——`better-sqlite3` 依赖里已经带了预编译的 SQLite。

## 2. 安装依赖

```powershell
cd D:\你的项目目录\sitemap-diff
npm install
```

装完之后，建议先跑一次环境体检（只读，不会修改任何东西）：

```powershell
.\scripts\check-installation.ps1
```

看到"体检结果：全部通过"再继续。如果有 `[错误]` 项，按脚本打印的中文修复命令处理。

## 3. 启动 / 停止面板

```powershell
.\scripts\start-dashboard.ps1
```

会自动打开浏览器到 `http://127.0.0.1:8766`。关闭这个 PowerShell 窗口**不会**停止后台服务（服务是独立进程）。

停止服务：

```powershell
.\scripts\stop-dashboard.ps1
```

也可以运行 `scripts\create-desktop-shortcuts.ps1` 在桌面创建三个快捷方式，之后不用再打开 PowerShell：

* **Sitemap监控面板** —— 打开/复用面板，不开始采集。
* **运行Sitemap监控** —— 启动面板并直接开始监控全部启用站点。
* **查看最新结果** —— 打开最近一次生成过报告的目录。

## 4. 站点管理

面板"站点管理" tab：新增/编辑站点、设置站点级抓取限制、配置手工 Sitemap、暂停/恢复某个站点的监控、对单个站点运行诊断。所有写操作都会先自动备份 `config/*.csv` 到 `config/backups/`，再原子写入，不会因为写到一半崩溃而损坏配置文件。

## 5. 运行监控

面板"实时运行" tab：

* **开始全部监控**：跑全部已启用站点。
* 也可以在"站点管理"里勾选部分站点，"运行选中站点"。
* 运行过程中可以点"安全停止"——当前正在处理的站点会正常跑完，后续未开始的站点不再调度，不会中途打断网络请求。

## 6. 查看新增 / 缺失 / 恢复

每个站点这次运行相对上一次**可靠**结果（`status=success && complete=true && truncated=false && 页面数>0`）的变化分四种：

| 类型 | 含义 |
|---|---|
| 新增 | 历史上第一次出现的 URL |
| 本轮缺失 | 上次可靠结果里有、这次没有——**不代表页面被永久删除** |
| 连续两轮缺失 | 连续两次可靠结果都没有——同样**不代表永久删除** |
| 恢复 | 之前缺失过、这次又出现了——**不算新增** |

站点表格每一行都有对应的"查看新增/查看缺失/查看连续缺失/查看恢复"按钮，点开是分页列表。如果某次运行是 partial/failed（不可靠），对应列会显示"未对比"而不是 0——这不是没有变化，而是这次结果根本没有参与比较。

首次运行（baseline）不会产生任何新增/缺失/恢复——这是正常行为，不是 bug。

## 7. AI 审查包在哪里

每次运行结束、报告生成后，在这次运行自己的目录下：

```text
output\YYYY-MM-DD\<run_id>\ai-review-package.zip
```

面板"报告"区块会显示这个路径（项目内相对路径，如 `output/2026-07-15/<run_id>/ai-review-package.zip`），并提供"复制文件路径"和"下载一个副本"两个按钮。**"下载一个副本"只是浏览器另存的一份拷贝**，正式文件始终留在上面那个项目目录里，不依赖浏览器下载目录。

ZIP 内 12 个文件：`manifest.json`（元数据）、`ai-review.json`（结构化四类变化数据）、`ai-review.txt`（可以直接粘贴给 ChatGPT/Claude/Gemini 的纯文本任务说明）+ 原有 9 个报告文件（`report.md`、`new-urls.csv` 等）。本工具自己**不调用任何 AI API**，AI 审查包只是把数据整理好，交不交给外部 AI 工具、交给哪个，由用户自己决定。

## 8. 备份与恢复

**备份和恢复之前都必须先停止面板服务**——面板运行时数据库文件正被进程打开（WAL 模式），直接复制可能拿到不一致的快照。`backup-local-data.ps1` 会自己检测端口 8766 是否在跑本项目的服务，检测到就直接拒绝备份并提示先停止，**不会自动帮你停止**：

```powershell
.\scripts\stop-dashboard.ps1
.\scripts\backup-local-data.ps1
```

会在 `backups\YYYY-MM-DD_HHmmss\` 下生成一份备份（数据库 + 三份配置 CSV + 可选审计日志）和 `backup-manifest.json`。

**恢复**（必须显式指定备份目录；同样必须先停止面板服务）：

```powershell
.\scripts\stop-dashboard.ps1
.\scripts\restore-local-data.ps1 -BackupDir "backups\2026-07-15_143022"
```

恢复脚本会先自动备份当前数据（万一恢复错了还能退回来），逐个文件用"临时文件 + 原子替换"的方式恢复。**只要这次恢复包含数据库文件，恢复后的 SQLite 完整性检查（`PRAGMA integrity_check`）就是强制步骤，不能跳过**——找不到 Node.js、`better-sqlite3` 加载失败、检查命令本身执行失败、或者检查结果不是 `ok`，都会被当成恢复失败处理。任何一步失败都会整体回滚：原本就存在的文件换回旧内容，这次恢复新建出来的文件会被删除，不会留下半份数据库或配置，也不会留下临时文件。

## 9. 遇到问题

先跑 `scripts\check-installation.ps1`，再看 `docs\WINDOWS_TROUBLESHOOTING.md`。
