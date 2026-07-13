-- 修复 sitemaps 表结构
-- 删除旧表并重新创建

-- 1. 删除旧的 sitemaps 表（保留数据的话先备份）
DROP TABLE IF EXISTS sitemaps CASCADE;

-- 2. 重新创建 sitemaps 表（正确的结构）
CREATE TABLE sitemaps (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    url_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_sitemaps_domain ON sitemaps(domain);

-- 4. 启用 RLS
ALTER TABLE sitemaps ENABLE ROW LEVEL SECURITY;

-- 5. 创建公开读取策略
DROP POLICY IF EXISTS "Allow public read on sitemaps" ON sitemaps;
CREATE POLICY "Allow public read on sitemaps" ON sitemaps FOR SELECT USING (true);

-- 6. 创建服务端写入策略
DROP POLICY IF EXISTS "Allow service write on sitemaps" ON sitemaps;
CREATE POLICY "Allow service write on sitemaps" ON sitemaps FOR ALL USING (true) WITH CHECK (true);
