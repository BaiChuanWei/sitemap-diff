# v0.1.0-local-rc1 发布候选说明

状态：**发布候选（Release Candidate）**，不是正式版本标签。本文档只是准备发布说明的草稿，**不代表已经完成用户在真实 Windows 环境的本地验收**——正式打 `v0.1.0` 标签需要等 `docs/M6_ACCEPTANCE_CHECKLIST.md` 里的全部项目在真实 Windows 机器上手工验收通过之后，由用户自己决定。

## 这个候选版本是什么

一个在 Windows 本地运行的单用户生产工具：稳定监控约 100 个游戏站点的 Sitemap，发现新增游戏 URL，并输出本地报告——不依赖任何云服务，不需要公网 Dashboard，不调用任何 AI API。

## 主要能力（截至本候选版本）

* Sitemap 采集：robots.txt 自动发现、Sitemap Index 递归、XML/XML.GZ、超时/重试/循环保护、有限并发、同域名多个 Sitemap。
* 基线与新增：首次运行只建立基线，后续运行准确找出新增 URL，失败不覆盖历史，重复运行不重复记录。
* 游戏页面初筛：排除分类/标签/静态资源等非游戏页，提取候选游戏名和置信度（high/medium/low），无法识别的 URL 仍然保留（`unknown`），不丢弃。
* URL 变化生命周期：在"新增"之外，还能判断每个已见 URL 是**本轮缺失**、**连续两轮缺失**还是**恢复**——均不代表页面被永久删除，只反映相对上一次可靠 Sitemap 结果的对比。partial/failed 的运行不参与这个比较。
* 本地 Web 面板：站点可视化管理（增/改/启停/限制/手工 Sitemap）、实时运行进度（含安全停止）、历史运行查询、报告下载。
* AI 审查包：每次运行结束在 `output\<日期>\<run_id>\ai-review-package.zip` 生成一份正式落盘的 zip（结构化 JSON + 纯文本任务说明 + 全部报告文件），供用户自行决定要不要上传给外部 AI 工具——本工具自身不调用任何 AI API、不需要任何 API Key。
* Windows 本地运维：环境体检脚本（只读）、启动/停止/一键运行/查看最新结果的桌面快捷方式、白名单式备份与带回滚保护的恢复脚本。

## 本候选版本明确不包含

* 定时任务 / Windows 任务计划程序自动调度（脚本已准备好被任务计划程序调用，但本候选版本不负责配置计划任务本身）。
* Electron / 系统托盘 / 安装器。
* 邮件、Telegram 等外部通知渠道。
* 云端部署（Supabase / Vercel / GitHub Actions 定时采集等）。
* OpenAI / Claude / Gemini 等 AI API 集成——AI 审查包只整理本地数据，不代表本工具会自动调用任何外部 AI 服务。
* 自动更新机制。

详见 `CURRENT_GOAL.md`。

## 已知限制

* `scripts\backup-local-data.ps1` 备份 `data\local.db` 时是文件级复制，不感知 SQLite 的 WAL/checkpoint 状态；如果面板服务正在运行，建议先 `stop-dashboard.ps1` 再备份，得到的快照更可靠（`restore-local-data.ps1` 恢复前会强制要求服务未运行，但备份本身不做这个强制检查）。
* 环境体检脚本、备份/恢复脚本目前只在沙盒里做过文本级静态校验和 Node 侧单元测试，尚未在真实 Windows 环境跑过——发布前必须完成 `docs/M6_ACCEPTANCE_CHECKLIST.md`。
* `ai-review.txt` 的分析建议是固定模板文字，不是任何 AI 生成的内容。

## 如何验收

见 `docs/M6_ACCEPTANCE_CHECKLIST.md`。全部通过后，由用户自行决定是否创建正式的 `v0.1.0` Git 标签。

## 版本对应关系

本候选版本基于 M1–M6 累计的全部提交，其中：

* M4：URL 变化生命周期（新增/缺失/连续两轮缺失/恢复）。
* M5：AI 审查包三份核心文件（`manifest.json` / `ai-review.json` / `ai-review.txt`）。
* M6：Windows 本地发布验收（环境体检、备份恢复、文档、本说明）。
