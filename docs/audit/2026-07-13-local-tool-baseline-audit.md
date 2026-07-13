# 只读审计报告：本地 Windows 工具方向重新对齐

日期：2026-07-13
范围：目标重新对齐（云端 SaaS → Windows 本地单机工具）+ 只读代码审计
产出方式：Lead Agent 直接审计（`main`/`BaiChuanWei-patch-1`/`claude/sitemap-trends-rebuild` 三个历史分支代码逐字节 Read + grep 交叉验证）

> 本文件是 `CLAUDE.md` 指令优先级第 4 项"最近一次审计报告"，Milestone 2 及之后的开发开始前应先读此文件。

## 1. 当前目标与现有代码的偏离（核心结论）

1. **真正运行入口**：唯一被自动化触发的是 GitHub Actions → `lib/check-sitemaps.js`（已归档到 `legacy/v2-cloud-supabase/`），本地工具需要全新的、不依赖云端 secrets 的入口。
2. **Sitemap Index 无法正确递归——原因**：`extractURLs()` 用正则 `/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi` 无差别抓取所有 `<loc>`，不解析 XML 根元素（不区分 `<sitemapindex>` 与 `<urlset>`），没有递归请求子 sitemap 的逻辑，也没有递归深度控制或循环引用保护（无 visited set）。这是 Milestone 2 要重写的核心问题。
3. **`.gz` 边界问题**：只按 URL 字符串后缀判断，不查 `Content-Type`/gzip 魔数（`0x1f 0x8b`）；判断错误时 `gunzipSync` 直接抛异常，被统一归为"下载失败"；全文件载入内存（非流式）。
4. **并发/超时/重试**：完全没有。纯 `for` 循环 + 固定 200ms delay，`fetch()` 无 `AbortController`，无重试，无 429 退避。
5. **首次基线可靠性**：域名级"首次只存不判新增"基本可靠，但粒度是"整个域名的 sitemap 全文"而非逐 URL，站点 sitemap 结构变化时旧基线会整体失效。
6. **新增 URL 因识别失败而丢失——会，最严重的偏离**：`extractGameName()` 返回 `null` 时代码路径是 `skippedCount++; continue;`，该 URL 不会被保存到任何地方。与 `CURRENT_GOAL.md` P0 铁律"所有新增 URL 都必须保留"直接冲突，Milestone 3/4 必须优先修复。
7. **切换到 SQLite 需要改的模块**：`lib/supabase.js` 整体替换；`lib/rss-manager.js` 里所有存储相关调用（`getFeeds/addFeed/getSitemapContent/saveSitemapContent/upsertGame/logUpdate`）需要重新指向 SQLite 实现，且数据模型要从"整份全文"改成"逐 URL 行"；`lib/check-sitemaps.js` 需新增报告生成、`output/` 写入、运行锁文件；`package.json` 移除 `@supabase/supabase-js`/`vercel`，新增 SQLite 驱动（Node 20 无内置 `node:sqlite`，需要 `better-sqlite3` 等第三方依赖）。
8. **测试和 fixture 缺口**：零测试文件、零测试配置、零 test script；`tests/fixtures/README.md`（旧执行包）列的 15 个 fixture 一个都不存在。`CLAUDE.md` 强制规则"不得在没有测试的情况下重写核心 Diff 逻辑"意味着 Milestone 1 必须先建测试框架和基础 fixture。

## 2. V1/V2 混杂清单（Milestone 1 已处理）

- V1（Cloudflare Workers + Discord/Telegram）：`src/`、`wrangler.toml` → 已归档至 `legacy/v1-cloudflare-workers/`
- V2（GitHub Actions + Supabase + Vercel/Next.js）：`lib/`、`web/`、`supabase/`、`.github/workflows/`、`vercel.json` → 已归档至 `legacy/v2-cloud-supabase/`
- 文档矛盾：旧 `README.md` 全篇按 V1 描述，`.claude.md` 按 V2 描述，两者互相矛盾且都不是当前目标 → 旧文档已移入 `docs/archive/`，`README.md` 已重写
- `scripts/extract_inparams_to_csv.py`：与本项目业务无关的孤立脚本（示例路径显示疑似从另一任务误传入），未处理，不属于 Milestone 1 范围，后续如确认无用可以单独清理

## 3. 数据安全原则（延续到本地工具，含义不变）

- 首次运行不能把已有 URL 当新增
- 抓取失败不能覆盖历史成功数据
- 空 Sitemap / 部分子 Sitemap 失败不能产生假变化
- 重复运行不能重复记录同一新增 URL（幂等）
- 所有新增 URL 必须保留，不能因识别失败而丢弃
- 单站失败不能终止全部任务

## 4. Milestone 1 范围说明

本文件写成时，Milestone 1（本地项目基线）与本审计报告在同一次改动中完成，具体交付见对应的 Milestone 完成报告。这里只记录审计结论，不记录实施细节。
