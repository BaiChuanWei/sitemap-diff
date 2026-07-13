# Milestone 2：数据库 V3

## 目标

在不丢失现有业务数据的前提下，增加站点、Endpoint、抓取、URL 事件、别名、审核和趋势表。

## 必须新增

- sites
- sitemap_endpoints
- crawl_runs
- site_urls
- url_events
- game_aliases
- game_merge_reviews
- daily_game_metrics

## 必须交付

- `supabase/schema-v3.sql`
- `supabase/migration-v2-to-v3.sql`
- `supabase/rollback-v3-to-v2.sql`
- `supabase/verify-v3.sql`

## 规则

- 同一域名允许多个 Sitemap
- 唯一约束以 site_id + endpoint URL 为主
- 不删除现有 games 和 game_sources
- 迁移前说明备份
- 迁移失败可回滚
- Service Key 不能进入前端
- RLS 只开放必要的公开视图

## 验证

- 空数据库建表
- V2 模拟数据迁移
- 回滚
- 再次迁移
- 唯一约束
- 索引
- RLS
- 数据数量一致

完成后停止。
