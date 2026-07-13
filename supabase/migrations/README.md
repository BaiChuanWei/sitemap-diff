# Supabase 迁移

## 约定

- 文件名格式：`NNNN_描述.up.sql` / `NNNN_描述.down.sql`，编号递增，一次迁移一个主题。
- 每个 `.up.sql` 必须有对应的 `.down.sql`。
- 迁移只做加法/策略调整，不做 `DROP TABLE`/`TRUNCATE` 这类破坏性操作（除非目标本来就是删除某个从未上线的对象）。
- 每个迁移的最后一步在 `schema_migrations` 表登记版本号，回滚时删除对应记录。
- 在 Supabase 控制台的 SQL Editor 里手动按顺序执行（本项目规模下不引入额外的迁移工具/CLI 依赖）。

## 现有迁移

| 文件 | 用途 | 能否直接在现有生产库执行 |
|---|---|---|
| `0000_baseline_v2_schema` | 当前生产 schema 的幂等快照，供全新/测试项目建库用 | **不要执行**——生产库的表和策略已存在，这个文件是"起点参照"，不是要应用的变更 |
| `0001_tighten_rls_to_service_role` | 把 `feeds/sitemaps/games/game_sources/update_logs` 的写策略从"任何人（含 anon）可写"收紧为"仅 service_role 可写"，读策略不变 | **是**，纯策略变更，不动表结构和数据，可以在生产库上执行 |

## 执行 0001 之前必须确认

1. Dashboard 的"增/删 sitemap"功能已经切到服务端 API route（`web/src/pages/api/feeds.ts`，用 `SUPABASE_SERVICE_KEY`），不再从浏览器用 anon key 直接写库。这一步已经随本次改动一起提交，部署上线后再执行本迁移。
2. 建议先在一个测试/预发 Supabase 项目上完整跑一遍 `0000` → `0001`，验证：
   - 用 `anon` key 直接调用 REST API 写 `feeds` 表应该被拒绝（`42501`）
   - Dashboard 页面的加/删 sitemap 功能（走新的 API route + service_role）仍然正常
3. 确认无误后，再对生产 Supabase 项目**只执行 `0001`**（生产库不需要也不应该跑 `0000`）。

## 历史脚本

`supabase/legacy/` 目录下是 V2 早期迭代中留下的一次性运维脚本（`migration.sql`、`fix-sitemaps-table.sql` 等），它们混合了破坏性的 `DROP TABLE ... CASCADE`、彼此有重叠、且没有对应回滚脚本。已归档保留、不再使用，后续所有数据库变更都走本目录下的编号迁移。
