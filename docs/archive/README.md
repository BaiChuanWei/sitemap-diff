# docs/archive/

按 `CLAUDE.md` 规则："`docs/archive/` 中的内容只作为未来参考，不属于当前实现范围。"

## 目录内容

- `claude-md-v2-cloud.md`：V2 云端方案时期的项目说明文档（原仓库根目录 `.claude.md`），描述 GitHub Actions + Supabase + Vercel 架构
- `QUICKSTART.md`、`DEPLOYMENT-CHECKLIST.md`、`WEB-DASHBOARD-SUMMARY.md`：V2 云端方案的部署/上手文档
- `sitemap-trends-cc-execution-pack-v1-2026-07-13.zip`：更早一版"约 100 站云端 SaaS"改造规划的完整执行包（含目标架构、Supabase V3 数据模型、7 个 Milestone 规划、验收清单等），在 `CURRENT_GOAL.md` 确定改为本地工具方向之前产出，现整体作为历史参考保留

## 为什么保留而不是删除

`CLAUDE.md` 强制规则："不得直接删除旧代码，删除前必须搜索引用。" 这些文档虽然描述的架构已经暂停，但记录了完整的历史决策过程和一套仍有参考价值的数据模型/验收设计思路（例如置信度分级、跨域名聚合、分层验收测试），未来如果重启云端方案，不需要从零重新设计。
