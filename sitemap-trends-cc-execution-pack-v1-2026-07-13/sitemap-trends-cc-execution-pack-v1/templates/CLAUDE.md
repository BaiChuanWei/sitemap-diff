# CLAUDE.md

开始任何工作前，必须依次阅读：

1. `START_HERE.md`
2. `docs/00_PROJECT_BRIEF.md`
3. `docs/01_FIRST_PRINCIPLES.md`
4. `docs/02_SCOPE_AND_PRIORITIES.md`
5. `docs/04_TARGET_ARCHITECTURE.md`
6. `docs/05_DATA_MODEL.md`
7. `docs/06_MILESTONES.md`
8. `docs/07_ACCEPTANCE_TESTS.md`
9. `docs/10_SAFETY_AND_ROLLBACK.md`

## 强制规则

- 不得直接修改 `main`。
- 不得跳过只读审计。
- 不得从零重写项目。
- 不得更换 Node.js、Supabase、Next.js、Vercel。
- 不得引入 Redis、Kafka、Kubernetes。
- 不得在未搜索引用前删除文件。
- 不得让抓取失败覆盖成功状态。
- 不得把首次基线当作新增。
- 不得打印或提交 Secret。
- 不得未经审核合并中等置信度游戏实体。
- 每个 Milestone 必须独立测试、独立提交、独立回滚。
- 完成一个 Milestone 后停止，不得自动进入下一阶段。

## 每阶段强制报告

1. 本阶段目标
2. 实际完成内容
3. 修改文件
4. 数据库变化
5. 新增依赖
6. 执行命令
7. 测试结果
8. 未通过项目
9. 已知风险
10. 未完成项
11. 回滚方式
12. Commit SHA
