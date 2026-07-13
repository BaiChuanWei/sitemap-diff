-- Sitemap Diff - Supabase Schema V2
-- 用于追踪跨平台游戏

-- 订阅源表
CREATE TABLE IF NOT EXISTS feeds (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sitemap 内容表（存储用于对比）
CREATE TABLE IF NOT EXISTS sitemaps (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    url_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 游戏表（核心）
CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    clean_name TEXT NOT NULL UNIQUE,
    platform_count INTEGER DEFAULT 1,
    score REAL DEFAULT 1.0,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 游戏来源表
CREATE TABLE IF NOT EXISTS game_sources (
    id SERIAL PRIMARY KEY,
    game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(game_id, domain)
);

-- 更新记录表
CREATE TABLE IF NOT EXISTS update_logs (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL,
    new_games_count INTEGER DEFAULT 0,
    new_games JSONB,
    checked_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_feeds_domain ON feeds(domain);
CREATE INDEX IF NOT EXISTS idx_sitemaps_domain ON sitemaps(domain);
CREATE INDEX IF NOT EXISTS idx_games_clean_name ON games(clean_name);
CREATE INDEX IF NOT EXISTS idx_games_platform_count ON games(platform_count DESC);
CREATE INDEX IF NOT EXISTS idx_games_score ON games(score DESC);
CREATE INDEX IF NOT EXISTS idx_games_first_seen ON games(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_game_sources_domain ON game_sources(domain);
CREATE INDEX IF NOT EXISTS idx_game_sources_url ON game_sources(url);
CREATE INDEX IF NOT EXISTS idx_update_logs_checked_at ON update_logs(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_update_logs_domain ON update_logs(domain);

-- 启用 RLS
ALTER TABLE feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE sitemaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE update_logs ENABLE ROW LEVEL SECURITY;

-- 公开读取策略
CREATE POLICY "Allow public read on feeds" ON feeds FOR SELECT USING (true);
CREATE POLICY "Allow public read on sitemaps" ON sitemaps FOR SELECT USING (true);
CREATE POLICY "Allow public read on games" ON games FOR SELECT USING (true);
CREATE POLICY "Allow public read on game_sources" ON game_sources FOR SELECT USING (true);
CREATE POLICY "Allow public read on update_logs" ON update_logs FOR SELECT USING (true);

-- 服务端写入策略
CREATE POLICY "Allow service write on feeds" ON feeds FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write on sitemaps" ON sitemaps FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write on games" ON games FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write on game_sources" ON game_sources FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write on update_logs" ON update_logs FOR ALL USING (true) WITH CHECK (true);

-- 清理旧日志的函数
CREATE OR REPLACE FUNCTION clean_old_logs(days_to_keep INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM update_logs
    WHERE checked_at < NOW() - (days_to_keep || ' days')::INTERVAL;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
