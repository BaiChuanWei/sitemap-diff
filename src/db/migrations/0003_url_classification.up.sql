-- 0003_url_classification.up.sql
--
-- Milestone 4：新增 URL 的页面初筛结果。每一条 added_url 都会得到一条分类记录
-- （game / non_game / unknown），无法识别的 URL 也保留为 unknown，绝不丢弃。
-- 不修改 seen_urls / added_urls 的核心唯一约束，不改变 baseline/added 语义。

CREATE TABLE IF NOT EXISTS url_classifications (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                TEXT NOT NULL,
    site_id               TEXT NOT NULL,
    url_hash              TEXT NOT NULL,
    original_url          TEXT NOT NULL,
    normalized_url        TEXT NOT NULL,
    sitemap_url           TEXT,
    page_type             TEXT NOT NULL,   -- game | non_game | unknown
    game_name             TEXT,
    confidence            TEXT,            -- high | medium | low
    evidence              TEXT,            -- JSON 数组
    classification_error  TEXT,
    classified_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, site_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_url_classifications_run ON url_classifications(run_id);
CREATE INDEX IF NOT EXISTS idx_url_classifications_type ON url_classifications(page_type);
