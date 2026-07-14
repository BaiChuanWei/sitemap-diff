-- 0005_url_lifecycle.down.sql
--
-- 只删除本迁移新建的表；site_crawl_runs / crawl_runs 新增的列不回滚
-- （SQLite 旧版本 DROP COLUMN 支持不一致，与既有迁移的约定一致）。

DROP TABLE IF EXISTS url_changes;
DROP TABLE IF EXISTS url_status;
