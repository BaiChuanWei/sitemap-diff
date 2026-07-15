# M6 Windows 本地发布验收清单

状态：待用户在真实 Windows 环境手工执行。沙盒容器没有真实 Windows 桌面/PowerShell 运行时，只能完成自动化测试和脚本文本级静态校验（见 `test/dashboard/powershell-scripts.test.js`），本清单列出的每一项都需要在真实 Windows 机器上人工走一遍。

> 建议顺序：环境体检 → 1 站 → 3 站 → 10 站 → 全部启用站点 → 安全停止 → 服务重启 → 备份恢复 → ZIP 解压 → 数据库完整性。前一项没通过不要跳到下一项。

## 0. 环境体检

```powershell
.\scripts\check-installation.ps1
```

- [ ] 输出"体检结果：全部通过"（或只有可接受的警告，没有 `[错误]`）。
- [ ] Node 主版本显示为 22。
- [ ] `process.versions.modules` 显示为 127。
- [ ] `npm test` 全量通过（记录通过数量，例如 349/349）。

## 1. 单站验收（1 站）

- [ ] `config\sites.csv` 只保留 1 个启用站点（先备份原文件）。
- [ ] `.\scripts\start-dashboard.ps1` 能正常启动，浏览器自动打开。
- [ ] 面板"实时运行"页点"开始全部监控"，首次运行结束后：该站"baseline"列显示"是"，新增/缺失/连续两轮缺失/恢复均为 0。
- [ ] 报告目录 `output\<日期>\<run_id>\` 下有完整 13 个文件（12 个报告文件 + `ai-review-package.zip`）。
- [ ] 再运行一次（数据不变的情况下），确认新增/缺失/恢复仍然是 0（幂等，没有假新增）。

## 2. 3 站验收

- [ ] 恢复到 3 个启用站点，重复一次"开始全部监控"。
- [ ] 站点表格三行都能正确显示状态（成功/部分/失败视真实站点情况而定）。
- [ ] 任意一个站点点"查看新增"（如果有）、"查看缺失"（如果有），确认分页列表能正常打开、URL 显示正确。

## 3. 10 站验收

- [ ] 恢复到 10 个启用站点，运行一次。
- [ ] 确认单个站点失败（如果真的出现）不影响其它站点继续完成。
- [ ] 确认"总览"页统计数字（总新增、今日新增等）和逐站表格加总一致。

## 4. 全部启用站点

- [ ] 恢复 `config\sites.csv` 到完整的约 100 个启用站点列表。
- [ ] "开始全部监控"，观察整轮耗时是否在可接受范围内。
- [ ] 运行结束后确认 `crawl_runs` 汇总（面板"运行历史"）与逐站表格 `site_crawl_runs` 计数一致（成功/部分/失败/新增/缺失/连续两轮缺失/恢复）。

## 5. 安全停止

- [ ] 全部站点运行中途点"安全停止"。
- [ ] 确认提示"已提交停止请求，当前正在处理的网站完成后停止"。
- [ ] 确认最终状态是 `cancelled`，已完成的站点历史正常保留，未开始的站点没有产生任何记录。
- [ ] 确认被取消的运行没有生成报告（`GET /api/runs/:id/report` 返回 409，面板不显示报告区块）。

## 6. 服务重启

- [ ] 运行中途（或运行间隙）用任务管理器强制结束 `node.exe`（模拟异常崩溃），或直接重启电脑。
- [ ] 重新 `.\scripts\start-dashboard.ps1`，确认面板空闲页提示"上次运行异常中断"。
- [ ] 确认历史数据没有丢失、没有损坏（`check-installation.ps1` 的完整性检查通过）。

## 7. 备份与恢复

- [ ] `.\scripts\backup-local-data.ps1`，确认 `backups\<时间戳>\` 下出现 `data\local.db`、`config\sites.csv` 等文件和 `backup-manifest.json`。
- [ ] 打开 `backup-manifest.json`，确认 `createdAt`/`gitCommit`/`nodeVersion`/`databaseSizeBytes`/`includedFiles` 字段都存在且合理。
- [ ] 修改（破坏）当前 `config\sites.csv` 内容（比如手工删掉几行），`.\scripts\stop-dashboard.ps1` 后执行：
  ```powershell
  .\scripts\restore-local-data.ps1 -BackupDir "backups\<刚才的时间戳>"
  ```
- [ ] 确认恢复后 `config\sites.csv` 内容和备份前一致。
- [ ] 确认恢复脚本运行前自动生成了"恢复前"的另一份备份（`backups\` 下应该能看到）。
- [ ] 故意指定一个不存在的 `-BackupDir`，确认脚本拒绝执行且不改动任何现有文件。
- [ ] 故意指定一个没有 `backup-manifest.json` 的目录，确认脚本拒绝执行。

## 8. ZIP 解压验证

- [ ] 任取一次运行的 `output\<日期>\<run_id>\ai-review-package.zip`，用 `Expand-Archive` 解压。
- [ ] 确认解压后正好 12 个文件，和 `manifest.json` 里的 `includedFiles` 一一对应。
- [ ] 确认 `ai-review.txt` 用记事本打开中文显示正常（UTF-8，无乱码）。
- [ ] 确认 `ai-review.json` 能被 `ConvertFrom-Json` 正确解析。

## 9. 数据库完整性

- [ ] `.\scripts\check-installation.ps1` 里的 `PRAGMA integrity_check` 结果是 `ok`。
- [ ] 连续两个完整运行周期（例如两天，或手工连续跑两次全部站点）之后再检查一次，确认仍然是 `ok`，且历史数据没有异常增长或丢失。

## 验收结论

- [ ] 以上全部项目通过，可以作为 `v0.1.0-local-rc1` 的验收依据（见 `docs/RELEASE_NOTES_v0.1.0-local-rc1.md`）。
- [ ] 任何一项不通过，记录具体现象和复现步骤，反馈后再继续。
