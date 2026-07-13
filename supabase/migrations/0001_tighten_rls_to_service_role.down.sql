-- 0001_tighten_rls_to_service_role.down.sql
--
-- 回滚：精确恢复到收紧之前的策略（未限定角色，anon 也可写）。
-- 仅在需要紧急回退时使用——回滚后 anon key 又可以直接写全部五张表，
-- 相当于重新打开本迁移修复的安全问题，回滚后请尽快重新排查再前进。

BEGIN;

DROP POLICY IF EXISTS "Allow service write on feeds" ON feeds;
CREATE POLICY "Allow service write on feeds" ON feeds
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service write on sitemaps" ON sitemaps;
CREATE POLICY "Allow service write on sitemaps" ON sitemaps
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service write on games" ON games;
CREATE POLICY "Allow service write on games" ON games
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service write on game_sources" ON game_sources;
CREATE POLICY "Allow service write on game_sources" ON game_sources
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service write on update_logs" ON update_logs;
CREATE POLICY "Allow service write on update_logs" ON update_logs
    FOR ALL USING (true) WITH CHECK (true);

DELETE FROM schema_migrations WHERE version = '0001_tighten_rls_to_service_role';

COMMIT;
