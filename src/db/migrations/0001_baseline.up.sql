-- 0001_baseline.up.sql
--
-- Milestone 1 基线：只建立迁移框架本身需要的记账表，和"本地配置"层面的
-- 站点注册表。不建 URL 历史 / 游戏实体相关的业务表——那些属于
-- Milestone 3（基线和新增 URL）、Milestone 4（游戏初筛）范围。

CREATE TABLE IF NOT EXISTS sites (
    site_id             TEXT PRIMARY KEY,
    domain              TEXT NOT NULL,
    priority            TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    robots_url          TEXT,
    sitemap_url         TEXT,
    expected_game_path  TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);
CREATE INDEX IF NOT EXISTS idx_sites_enabled ON sites(enabled);
