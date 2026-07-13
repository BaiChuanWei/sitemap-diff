-- 0001_tighten_rls_to_service_role.up.sql
--
-- 目的：修复安全审计发现的问题——现有 "Allow service write on X" 策略用
-- FOR ALL USING (true) WITH CHECK (true)，没有用 TO 限定角色，导致 anon
-- 角色（Next.js Dashboard 浏览器端用的公开 NEXT_PUBLIC_SUPABASE_ANON_KEY）
-- 同样可以对 feeds/sitemaps/games/game_sources/update_logs 五张表做任意
-- 增删改，而不仅限于 Dashboard UI 暴露的"增删 sitemap"。
--
-- 变更内容：只替换这 5 条写策略，加上 TO service_role 限定；不改表结构、
-- 不改任何数据、不改读策略（anon 仍可 SELECT）。是纯策略级变更，可安全
-- 在有真实数据的生产库上执行，不会丢数据。
--
-- 执行前提：Dashboard 的"增/删 sitemap"功能必须已经改成走服务端 API
-- （web/src/pages/api/feeds.ts，使用 SUPABASE_SERVICE_KEY），否则执行完
-- 这个迁移后，浏览器端直接调用 supabase.from('feeds').insert(...) 会开始
-- 收到 RLS 拒绝（42501）。建议顺序：
--   1. 先部署好新的 API route（见本次改动的 web/ 部分）
--   2. 在测试/预发 Supabase 项目上验证：用 anon key 直接调用 REST API 应该
--      被拒绝，用 service_role key（服务端 API route）应该成功
--   3. 确认无误后再对生产 Supabase 项目执行本文件

BEGIN;

DROP POLICY IF EXISTS "Allow service write on feeds" ON feeds;
CREATE POLICY "Allow service write on feeds" ON feeds
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service write on sitemaps" ON sitemaps;
CREATE POLICY "Allow service write on sitemaps" ON sitemaps
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service write on games" ON games;
CREATE POLICY "Allow service write on games" ON games
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service write on game_sources" ON game_sources;
CREATE POLICY "Allow service write on game_sources" ON game_sources
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service write on update_logs" ON update_logs;
CREATE POLICY "Allow service write on update_logs" ON update_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO schema_migrations (version)
VALUES ('0001_tighten_rls_to_service_role')
ON CONFLICT (version) DO NOTHING;

COMMIT;
