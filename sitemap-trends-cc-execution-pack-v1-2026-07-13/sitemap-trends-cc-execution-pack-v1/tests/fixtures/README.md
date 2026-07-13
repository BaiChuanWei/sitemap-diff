# 测试 Fixture 清单

需要创建以下可重复样本：

- `urlset-old.xml`
- `urlset-new.xml`
- `sitemap-index.xml`
- `nested-sitemap-index.xml`
- `child-games-1.xml`
- `child-games-2.xml`
- `sitemap.xml.gz`
- `empty.xml`
- `truncated.xml`
- `html-instead-of-xml.html`
- `circular-index-a.xml`
- `circular-index-b.xml`
- `duplicate-urls.xml`
- `large-drop-old.xml`
- `large-drop-new.xml`

必须覆盖：

- baseline
- added
- removed
- restored
- 幂等
- Sitemap Index
- GZ
- 空响应
- 截断
- HTML 冒充 XML
- 循环引用
- URL 数量下降 90%
- 同一 URL 出现在多个 Sitemap
