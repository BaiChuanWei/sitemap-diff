-- 0004_run_mode.up.sql
--
-- Dashboard M3：网页运行控制。记录一次运行是"全部启用站点"还是"选中站点"，
-- 以及选中时具体是哪些 site_id——这样运行结束、内存态清空之后，仍能在
-- GET /api/runs/:run_id 里看到"这次运行的模式和范围"，不需要额外的表。
-- 两列都允许为空：历史上通过 CLI 触发的运行（Milestone 3 及更早）没有这个
-- 概念，保持 NULL 即可，不做回填，不改变既有行的语义。

ALTER TABLE crawl_runs ADD COLUMN run_mode TEXT;       -- 'all' | 'selected'，NULL = 未记录（如 CLI 触发）
ALTER TABLE crawl_runs ADD COLUMN site_selection TEXT; -- run_mode='selected' 时：请求的 site_id JSON 数组；否则 NULL
