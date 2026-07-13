# Sitemap 游戏趋势监控系统：CC Web 执行包

版本：v1.0  
日期：2026-07-13  
适用规模：约 100 个在线小游戏网站  
开发方式：CC Web / Claude Code，多阶段、可审计、可回滚

## 先做什么

1. Fork 上游仓库：
   - 上游：`https://github.com/Yangjia23/sitemap-diff`
   - 实际开发仓库：填写你自己的 Fork 地址。
2. 将本包中的文档复制到开发仓库根目录。
3. 把 `templates/CLAUDE.md` 复制为仓库根目录的 `CLAUDE.md`。
4. 把 `templates/seed-sites.csv` 复制为 `data/seed-sites.csv`，填写约 100 个目标站点。
5. 在测试环境中准备 Supabase，不要第一轮连接生产数据库。
6. 先把 `prompts/00_context_alignment_prompt.md` 发给 CC Web。
7. 只有 CC 对目标复述正确，才进入 `prompts/01_read_only_audit_prompt.md`。
8. 后续严格按 Milestone 顺序执行，不要一次性把所有开发任务交给 CC。

## 最重要的产品结果

第一版最重要的结果不是漂亮页面，而是：

> 约 100 个游戏站能够稳定检查；首次运行只建基线；后续每天准确输出新增游戏 URL；失败不产生假新增、假删除；结果可查看、筛选、下载 CSV/JSON。

## 文件导航

- `docs/00_PROJECT_BRIEF.md`：项目总目标
- `docs/01_FIRST_PRINCIPLES.md`：第一性原理
- `docs/02_SCOPE_AND_PRIORITIES.md`：优先级、范围与非目标
- `docs/03_REFERENCE_SOURCES.md`：仓库与产品参考
- `docs/04_TARGET_ARCHITECTURE.md`：目标架构
- `docs/05_DATA_MODEL.md`：数据库建议
- `docs/06_MILESTONES.md`：7 个里程碑
- `docs/07_ACCEPTANCE_TESTS.md`：分层验收
- `docs/08_CC_WEB_MULTI_AGENT_WORKFLOW.md`：多 Agent 使用规则
- `docs/09_MANAGER_CHECKLIST.md`：经理执行清单
- `docs/10_SAFETY_AND_ROLLBACK.md`：安全与回滚
- `prompts/`：逐阶段可直接复制给 CC 的 Prompt
- `templates/`：CLAUDE.md、站点清单、阶段报告模板
- `tests/fixtures/README.md`：必须准备的测试样本
