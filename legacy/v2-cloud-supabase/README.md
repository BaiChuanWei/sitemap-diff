# V2（已暂停）— GitHub Actions + Supabase + Vercel/Next.js

这是项目在"云端 SaaS"方向上的实现：GitHub Actions 定时抓取 → Supabase Postgres 存储 → Vercel 上的 Next.js Dashboard 展示。

根据 `CURRENT_GOAL.md`，当前目标已改为 Windows 本地单用户工具，**不做 Supabase、Vercel、GitHub Actions、公网 Dashboard**。这套代码整体暂停，不代表方向错误，只是不在当前实现范围内，按 `CLAUDE.md` 强制规则"不得直接删除旧代码"归档保留，不删除。

## 目录说明

- `lib/`：GitHub Actions 定时任务的爬虫核心（`check-sitemaps.js` 入口 → `rss-manager.js` 抓取/对比/游戏提取 → `supabase.js` 数据读写）
- `web/`：Next.js Dashboard（Vercel 部署）
- `supabase/`：Postgres schema、历史迁移脚本、数据污染诊断/清理工具
- `.github/workflows/check-sitemaps.yml`：GitHub Actions 定时任务配置
- `vercel.json`：Vercel 部署配置

## 迁移到本地工具时值得复用的逻辑

`lib/rss-manager.js` 里以下**纯函数逻辑**与存储后端无关，是设计新的本地采集器（Milestone 2/3/4）时的参考起点，但不能直接照搬调用（原函数绑定了 Supabase 读写和"整份 sitemap 全文对比"的存储模型，新实现要改成逐 URL 落 SQLite）：

- `extractURLs(content)`：正则抓取 `<loc>` 标签——**已知缺陷**：不区分 `<sitemapindex>` 和 `<urlset>`，无法正确处理 Sitemap Index，Milestone 2 必须重写
- `extractGameName(url)` / `normalizeGameName(name)`：9 个已知游戏聚合平台的 URL 规则 + 分类关键词黑名单，Milestone 4 设计置信度分级时的起点
- `downloadSitemap()` 里的三层异常检测（0 URL 拒绝 / 新增较旧减少超 50% 拒绝 / 首次 URL 数 < 10 拒绝）：这套"失败不能变成假新增"的保护思路，是 Milestone 3 数据保护逻辑的参考基础

**已知问题**（详见 `docs/audit/` 下的审计报告）：未命中游戏识别的新增 URL 会被直接丢弃、不落库；同域名只能绑定一个 sitemap；无并发/超时/重试控制；Supabase RLS 写策略未限定角色（`FOR ALL USING (true)`），浏览器端 anon key 理论上可写全部业务表。这些问题在本地工具方案里不需要修复（因为不再用 Supabase/公网 Dashboard），但如果未来第二阶段重启云端方案，需要重新处理。
