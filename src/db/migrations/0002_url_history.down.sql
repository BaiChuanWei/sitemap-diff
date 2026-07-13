-- 0002_url_history.down.sql
-- 回滚 Milestone 3 的 URL 历史与运行记录表。SQLite 不支持 DROP COLUMN
-- 的旧版本较多，这里只回滚本迁移新建的表；sites 上新增的列保留不影响
-- Milestone 1 的功能（如需彻底回滚，用 0001 的重建流程）。
DROP TABLE IF EXISTS added_urls;
DROP TABLE IF EXISTS site_crawl_runs;
DROP TABLE IF EXISTS crawl_runs;
DROP TABLE IF EXISTS seen_urls;
DROP TABLE IF EXISTS sitemap_endpoints;
