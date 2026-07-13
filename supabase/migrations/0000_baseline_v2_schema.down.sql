-- 0000_baseline_v2_schema.down.sql
--
-- 仅用于全新/测试 Supabase 项目的清空回滚。
-- ⚠️ 不要在生产项目上执行——这会删除全部业务数据。

DROP FUNCTION IF EXISTS clean_old_logs(INTEGER);
DROP TABLE IF EXISTS schema_migrations;
DROP TABLE IF EXISTS update_logs CASCADE;
DROP TABLE IF EXISTS game_sources CASCADE;
DROP TABLE IF EXISTS games CASCADE;
DROP TABLE IF EXISTS sitemaps CASCADE;
DROP TABLE IF EXISTS feeds CASCADE;
