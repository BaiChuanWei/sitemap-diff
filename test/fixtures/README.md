# 测试 Fixture 清单

Milestone 1 建立的 fixture 基线，供 Milestone 2（Sitemap 采集器）和 Milestone 3（基线/新增 URL）开发时使用。这些文件目前只是静态测试数据，本阶段没有对应的解析/递归逻辑去正确处理其中大部分场景（那是 M2/M3 的范围）——`test/fixtures.test.js` 只验证这些文件本身的完整性（存在、非空、基本格式特征），不测试尚不存在的业务逻辑。

| 文件 | 用途 |
|---|---|
| `urlset-old.xml` | 普通 urlset，3 个 URL，作为"旧版本" |
| `urlset-new.xml` | 同上 + 1 个新 URL（4 个），作为"新版本"，用于 M3 baseline/added 测试 |
| `sitemap-index.xml` | Sitemap Index，指向 `child-games-1.xml`、`child-games-2.xml` 两个子 sitemap |
| `nested-sitemap-index.xml` | 两层嵌套 Index，指向 `sitemap-index.xml` |
| `child-games-1.xml` / `child-games-2.xml` | Index 下的子 sitemap，各含 2 个游戏 URL |
| `sitemap.xml.gz` | `urlset-old.xml` 的真实 gzip 压缩版本（已用 `zlib.gzipSync` 生成，magic bytes 已验证为 `1f 8b`） |
| `empty.xml` | 合法但零 URL 的 urlset，对应 P0"空 Sitemap 不能产生假变化" |
| `truncated.xml` | 故意从标签中间截断的不完整 XML |
| `html-instead-of-xml.html` | 服务器返回错误页面（HTML）而不是 XML 的场景 |
| `circular-index-a.xml` / `circular-index-b.xml` | 两个 Index 互相指向对方，测试循环引用保护 |
| `duplicate-urls.xml` | 同一个 `<loc>` 出现两次 |
| `large-drop-old.xml` / `large-drop-new.xml` | 20 个 URL → 2 个 URL，超过 90% 骤降，对应异常检测场景 |

来源：字段设计延续自 `docs/archive/` 里旧执行包的 `tests/fixtures/README.md`，与存储后端（Supabase 还是 SQLite）无关，Milestone 1 阶段原样保留复用。
