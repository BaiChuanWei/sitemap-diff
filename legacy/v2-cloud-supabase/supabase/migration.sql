-- 数据库迁移脚本：从 V1 升级到 V2
-- 执行此脚本前请备份数据

-- 1. 删除旧的 sitemaps 表（如果存在）
DROP TABLE IF EXISTS sitemaps CASCADE;

-- 2. 更新 update_logs 表结构
-- 如果表存在且有旧数据，先删除重建
DROP TABLE IF EXISTS update_logs CASCADE;

-- 重新创建 update_logs 表
CREATE TABLE IF NOT EXISTS update_logs (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL,
    new_games_count INTEGER DEFAULT 0,
    new_games JSONB,
    checked_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 创建 games 表（如果不存在）
CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    clean_name TEXT NOT NULL UNIQUE,
    platform_count INTEGER DEFAULT 1,
    score REAL DEFAULT 1.0,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 创建 game_sources 表（如果不存在）
CREATE TABLE IF NOT EXISTS game_sources (
    id SERIAL PRIMARY KEY,
    game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(game_id, domain)
);

-- 5. 重新创建索引
DROP INDEX IF EXISTS idx_update_logs_checked_at;
DROP INDEX IF EXISTS idx_update_logs_domain;
DROP INDEX IF EXISTS idx_games_clean_name;
DROP INDEX IF EXISTS idx_games_platform_count;
DROP INDEX IF EXISTS idx_games_score;
DROP INDEX IF EXISTS idx_games_first_seen;
DROP INDEX IF EXISTS idx_game_sources_domain;
DROP INDEX IF EXISTS idx_game_sources_url;

CREATE INDEX idx_update_logs_checked_at ON update_logs(checked_at DESC);
CREATE INDEX idx_update_logs_domain ON update_logs(domain);
CREATE INDEX idx_games_clean_name ON games(clean_name);
CREATE INDEX idx_games_platform_count ON games(platform_count DESC);
CREATE INDEX idx_games_score ON games(score DESC);
CREATE INDEX idx_games_first_seen ON games(first_seen DESC);
CREATE INDEX idx_game_sources_domain ON game_sources(domain);
CREATE INDEX idx_game_sources_url ON game_sources(url);

-- 6. 重新设置 RLS 策略
ALTER TABLE update_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read on update_logs" ON update_logs;
DROP POLICY IF EXISTS "Allow public read on games" ON games;
DROP POLICY IF EXISTS "Allow public read on game_sources" ON game_sources;
DROP POLICY IF EXISTS "Allow service write on update_logs" ON update_logs;
DROP POLICY IF EXISTS "Allow service write on games" ON games;
DROP POLICY IF EXISTS "Allow service write on game_sources" ON game_sources;

CREATE POLICY "Allow public read on update_logs" ON update_logs FOR SELECT USING (true);
CREATE POLICY "Allow public read on games" ON games FOR SELECT USING (true);
CREATE POLICY "Allow public read on game_sources" ON game_sources FOR SELECT USING (true);
CREATE POLICY "Allow service write on update_logs" ON update_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write on games" ON games FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write on game_sources" ON game_sources FOR ALL USING (true) WITH CHECK (true);

-- 完成！
SELECT 'Migration completed successfully!' as status;
