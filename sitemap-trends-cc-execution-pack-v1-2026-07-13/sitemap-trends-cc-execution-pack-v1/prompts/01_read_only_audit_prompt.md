# 阶段 1：只读审计 Prompt

执行只读审计。禁止编辑、删除、迁移、部署和提交。

存在多 Agent 能力时，创建三个只读 Agent：

1. Repository Auditor
2. Data & Security Auditor
3. Crawler & Test Auditor

没有多 Agent 能力时，由 Lead Agent 依次完成。

## 必须阅读

- README
- CLAUDE.md
- package.json
- .github/workflows
- lib/check-sitemaps.js
- lib/rss-manager.js
- lib/supabase.js
- supabase/
- web/package.json
- web/src/
- vercel 配置
- Cloudflare 遗留配置
- 所有测试
- .gitignore
- 环境变量示例

## 输出

1. 当前真实生产架构
2. 当前数据流
3. 已有能力
4. 缺失能力
5. V1/V2 混杂清单
6. 同域名多 Sitemap 风险
7. Sitemap Index 风险
8. XML 解析风险
9. 并发和超时风险
10. 数据污染风险
11. RLS 和 Secret 风险
12. 测试缺口
13. 7 个 Milestone 的修订建议
14. 第一阶段最小修改范围
15. 阻塞问题

在确认前不要修改代码。
