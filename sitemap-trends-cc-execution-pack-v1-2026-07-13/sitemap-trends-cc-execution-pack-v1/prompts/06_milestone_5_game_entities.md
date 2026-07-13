# Milestone 5：游戏识别与实体聚合

## 目标

把新增 URL 转成可审核的游戏候选，并按独立域名聚合。

## 必须实现

- 站点 URL 规则配置化
- 排除分类、标签、博客、搜索、静态资源
- slug 提取
- title / H1 / og:title / canonical / JSON-LD
- 候选证据
- confidence
- exact / high / medium / low
- game_aliases
- medium 进入人工审核
- 同一游戏同一域名只计一次
- 同站多个 URL 可保留
- 人工 merge / split

## 禁止

- 只依靠 URL 最后一段作为最终游戏名
- 把 medium 自动合并
- 去除续作数字和年份
- 调用 LLM 作为唯一判断来源

## 验证

- 同名不同格式正确合并
- online/free/unblocked 修饰词案例
- 续作数字保护
- 同名不同游戏不盲目合并
- 多语言 URL 域名只计一次
