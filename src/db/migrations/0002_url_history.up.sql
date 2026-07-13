-- 0002_url_history.up.sql
--
-- Milestone 3：URL 历史与新增判定。沿用 Milestone 1 的迁移体系，不另起一套
-- 数据库初始化方式。本迁移只建立"逐 URL 行"的历史与运行记录表，不涉及游戏
-- 识别 / 置信度 / removed / restored（那些属于后续 Milestone）。

-- sites：补充运行状态与 baseline 完成标记（不动 Milestone 1 已有列）。
ALTER TABLE sites ADD COLUMN last_attempt_at        TEXT;
ALTER TABLE sites ADD COLUMN last_success_at        TEXT;
ALTER TABLE sites ADD COLUMN last_status            TEXT;
ALTER TABLE sites ADD COLUMN last_error             TEXT;
ALTER TABLE sites ADD COLUMN baseline_completed_at  TEXT;

-- 一个站点允许有多个 Sitemap Endpoint。
CREATE TABLE IF NOT EXISTS sitemap_endpoints (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id        TEXT NOT NULL,
    url            TEXT NOT NULL,
    first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_status    TEXT,
    UNIQUE(site_id, url)
);
CREATE INDEX IF NOT EXISTS idx_sitemap_endpoints_site ON sitemap_endpoints(site_id);

-- seen_urls：某站点历史上见过的全部页面 URL（逐 URL 行）。
-- 同时保存 original_url 与 normalized_url，url_hash 基于 normalized_url。
CREATE TABLE IF NOT EXISTS seen_urls (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id        TEXT NOT NULL,
    original_url   TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    url_hash       TEXT NOT NULL,
    first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    first_run_id   TEXT,
    last_run_id    TEXT,
    UNIQUE(site_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_seen_urls_site ON seen_urls(site_id);

-- crawl_runs：一次整体运行（可能覆盖多个站点）的汇总记录。
CREATE TABLE IF NOT EXISTS crawl_runs (
    run_id               TEXT PRIMARY KEY,
    started_at           TEXT NOT NULL,
    finished_at          TEXT,
    status               TEXT,
    sites_total          INTEGER NOT NULL DEFAULT 0,
    sites_success        INTEGER NOT NULL DEFAULT 0,
    sites_partial        INTEGER NOT NULL DEFAULT 0,
    sites_failed         INTEGER NOT NULL DEFAULT 0,
    baseline_site_count  INTEGER NOT NULL DEFAULT 0,
    baseline_url_count   INTEGER NOT NULL DEFAULT 0,
    added_url_count      INTEGER NOT NULL DEFAULT 0,
    error_summary        TEXT
);

-- site_crawl_runs：站点级运行结果（成功 / partial / failed 都记录）。
CREATE TABLE IF NOT EXISTS site_crawl_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           TEXT NOT NULL,
    site_id          TEXT NOT NULL,
    status           TEXT,
    complete         INTEGER,
    truncated        INTEGER,
    page_url_count   INTEGER NOT NULL DEFAULT 0,
    added_url_count  INTEGER NOT NULL DEFAULT 0,
    started_at       TEXT,
    finished_at      TEXT,
    duration_ms      INTEGER,
    error_summary    TEXT,
    UNIQUE(run_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_site_crawl_runs_run ON site_crawl_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_site_crawl_runs_site ON site_crawl_runs(site_id);

-- added_urls：某次运行中，某站点第一次出现的新增 URL。
-- UNIQUE(site_id, url_hash) 保证同一站点的同一 URL 只会被记录为新增一次。
CREATE TABLE IF NOT EXISTS added_urls (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL,
    site_id        TEXT NOT NULL,
    sitemap_url    TEXT,
    original_url   TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    url_hash       TEXT NOT NULL,
    detected_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(site_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_added_urls_run ON added_urls(run_id);
CREATE INDEX IF NOT EXISTS idx_added_urls_site ON added_urls(site_id);
