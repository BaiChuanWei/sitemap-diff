-- 0005_url_lifecycle.up.sql
--
-- Dashboard M4：URL 变化生命周期（missing / consecutive_missing / restored）。
-- 复用现有的可靠运行准入规则（isAdmissible）与 seen_urls / added_urls 的
-- "新增"语义，完全不改动；只新增两张最小必要的表：
--   url_status  —— 每个 URL 当前是否存在、连续缺失了几轮，供下一次运行
--                   比较用（"当前状态"，不是历史流水）。
--   url_changes —— 每次运行产生的 missing / consecutive_missing / restored
--                   事件（"历史流水"，供分页查询和报告使用）。added 事件
--                   继续只记录在 added_urls，这里不重复存储。
-- site_crawl_runs / crawl_runs 各加 4 列汇总计数，与已有的 added_url_count
-- 列并列，不新建第三张表。

CREATE TABLE IF NOT EXISTS url_status (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id            TEXT NOT NULL,
    url_hash           TEXT NOT NULL,
    original_url       TEXT NOT NULL,
    normalized_url     TEXT NOT NULL,
    is_present         INTEGER NOT NULL DEFAULT 1,
    missing_streak     INTEGER NOT NULL DEFAULT 0,
    last_seen_run_id   TEXT,
    last_change_run_id TEXT,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(site_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_url_status_site ON url_status(site_id);
CREATE INDEX IF NOT EXISTS idx_url_status_present ON url_status(site_id, is_present);

CREATE TABLE IF NOT EXISTS url_changes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL,
    site_id        TEXT NOT NULL,
    url_hash       TEXT NOT NULL,
    original_url   TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    change_type    TEXT NOT NULL,  -- missing | consecutive_missing | restored
    detected_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, site_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_url_changes_run ON url_changes(run_id);
CREATE INDEX IF NOT EXISTS idx_url_changes_site ON url_changes(site_id);
CREATE INDEX IF NOT EXISTS idx_url_changes_type ON url_changes(change_type);

ALTER TABLE site_crawl_runs ADD COLUMN missing_url_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_crawl_runs ADD COLUMN consecutive_missing_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_crawl_runs ADD COLUMN restored_url_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_crawl_runs ADD COLUMN comparison_performed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crawl_runs ADD COLUMN missing_url_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN consecutive_missing_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN restored_url_count INTEGER NOT NULL DEFAULT 0;
