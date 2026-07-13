-- 0003_url_classification.down.sql
-- 回滚 Milestone 4 的分类结果表；不影响 seen_urls / added_urls 历史。
DROP TABLE IF EXISTS url_classifications;
