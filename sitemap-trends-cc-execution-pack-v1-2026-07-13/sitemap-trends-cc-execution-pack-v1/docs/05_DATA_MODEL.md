# 05｜数据库模型建议

## 1. sites

保存站点级状态：

- id
- site_id
- domain
- enabled
- priority
- robots_url
- status
- last_attempt_at
- last_success_at
- consecutive_failures
- created_at
- updated_at

## 2. sitemap_endpoints

同一域名可有多个 Endpoint：

- id
- site_id
- url
- endpoint_type
- last_content_hash
- last_url_count
- etag
- last_modified
- status
- last_success_at
- last_error

唯一约束：

```text
UNIQUE(site_id, url)
```

## 3. crawl_runs

- id
- run_id
- shard
- started_at
- finished_at
- status
- sites_total
- sites_success
- sites_partial
- sites_failed

## 4. site_urls

保存当前 URL 状态：

- id
- site_id
- canonical_url
- url_hash
- first_seen_at
- last_seen_at
- is_active
- missing_successful_runs
- page_type
- game_id

唯一约束：

```text
UNIQUE(site_id, url_hash)
```

## 5. url_events

- id
- site_id
- sitemap_endpoint_id
- canonical_url
- event_type
- detected_at
- crawl_run_id

事件类型：

- baseline
- added
- removed
- restored

## 6. games

- id
- canonical_name
- normalized_name
- first_seen_at
- last_seen_at
- domains_total
- review_status

## 7. game_aliases

- id
- game_id
- alias
- normalized_alias
- source_domain
- confidence

## 8. game_sources

- id
- game_id
- site_id
- source_url
- first_seen_at
- last_seen_at
- is_active

趋势统计以独立 `site_id` 计数，但允许保存同站多个 URL。

## 9. game_merge_reviews

- id
- candidate_game_id
- possible_target_game_id
- confidence
- evidence
- status
- reviewer_note

## 10. daily_game_metrics

- game_id
- date
- domains_added_24h
- domains_added_7d
- domains_added_30d
- domains_total
- trend_score

## 11. 数据安全规则

- 抓取失败不得更新成功快照
- 首次运行只写 baseline
- removed 至少连续两次成功抓取缺失后确认
- 数据库写入以站点为事务边界
- 重跑必须幂等
- 所有业务事件长期保留
- 运维日志可以按保留策略清理
