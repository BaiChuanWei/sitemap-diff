# CLAUDE.md

## 指令优先级

开始任何工作前，必须按照以下顺序读取：

1. `CURRENT_GOAL.md`
2. `CLAUDE.md`
3. 当前阶段 Prompt
4. 最近一次审计报告
5. 当前代码和测试
6. 其他历史文档

如历史 README、旧执行包、Supabase 方案、Vercel 方案或云端产品方案与 `CURRENT_GOAL.md` 冲突，以 `CURRENT_GOAL.md` 为准。

`docs/archive/` 中的内容只作为未来参考，不属于当前实现范围。

## 当前项目性质

这是一个 Windows 本地运行的单用户生产工具。

当前核心目标是：

> 稳定监控约 100 个游戏站，发现新增游戏 URL，并输出本地报告。

## 强制规则

* 不得从零重写项目；
* 不得擅自恢复 Supabase、Vercel 或 GitHub Actions 云端方案；
* 不得引入 Redis、Kafka、Kubernetes；
* 不得直接删除旧代码，删除前必须搜索引用；
* 不得让抓取失败覆盖历史成功数据；
* 不得把首次基线当成新增；
* 不得把 Sitemap Index 中的子 Sitemap URL 当作页面 URL；
* 不得丢弃无法识别游戏名称的新增 URL；
* 不得让一个站点失败终止全部任务；
* 不得在没有测试的情况下重写核心 Diff 逻辑；
* 每次只执行一个 Milestone；
* 每个 Milestone 必须独立测试和独立提交；
* 完成当前 Milestone 后停止，不得自行进入下一个阶段。

## 当前 5 个 Milestone

### Milestone 1：本地项目基线

* 确认真正运行入口；
* 区分活跃代码和遗留代码；
* 建立测试框架；
* 建立 SQLite；
* 建立本地配置；
* 保证现有可复用代码仍可运行。

### Milestone 2：Sitemap 采集器

* robots.txt；
* Sitemap Index；
* 多层递归；
* XML；
* XML.GZ；
* 超时；
* 重试；
* 循环保护；
* 同域名多个 Sitemap；
* 有限并发。

### Milestone 3：基线和新增 URL

* 首次 baseline；
* 后续 added；
* SQLite 历史；
* 幂等；
* 失败不覆盖；
* 锁文件防止重复运行。

### Milestone 4：游戏初筛和报告

* 游戏 URL 规则；
* 分类页排除；
* 候选游戏名；
* 置信度；
* CSV；
* JSON；
* Markdown；
* 未识别 URL 清单。

### Milestone 5：100 站生产验证

* fixture；
* 3 站；
* 10 站；
* 20 站；
* 100 站；
* 连续两个完整周期；
* Windows 任务计划程序说明；
* 备份和恢复说明。

## 每阶段强制报告

完成每个 Milestone 后必须报告：

1. 本阶段目标；
2. 实际完成内容；
3. 修改文件；
4. 新增依赖；
5. 数据库变化；
6. 执行命令；
7. 测试结果；
8. 未通过测试；
9. 已知风险；
10. 未完成项；
11. 回滚方法；
12. Commit SHA。

禁止只回复"已完成"。
