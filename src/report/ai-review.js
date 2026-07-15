/**
 * Dashboard M5：AI 审查包的三份核心文件。
 *
 *   manifest.json  —— 结构化元数据（运行信息 + 统计 + 文件清单 + 警告）。
 *   ai-review.json —— 合并 added/missing/consecutive_missing/restored 四类
 *                      变化的结构化条目，供程序化 AI 消费。
 *   ai-review.txt  —— 给人工直接粘贴进 ChatGPT/Claude/Gemini 的纯文本任务
 *                      说明，本工具自己不调用任何 AI API。
 *
 * 三份文件都只读取 report.js 已经算好的数据（run 信息 / summary / items /
 * siteRuns），不重新访问网络、不重新分类、不编造任何字段——没有的数据
 * 一律 null，不猜测 title、发布时间或热度。
 */

export const AI_REVIEW_WARNINGS = [
  'missing（本轮缺失）不代表页面被永久删除。',
  'consecutive_missing（连续两轮缺失）不代表页面被永久删除。',
  'restored 是历史 URL 重新出现，不是新增。',
  'baseline（首次运行）中的 URL 不属于新增。',
  'partial 和 failed 状态的站点数据不完整，未执行可靠的变化比较。',
];

const AI_REVIEW_INSTRUCTIONS = [
  '这是一次 Sitemap 变化 AI 审查任务的结构化数据，供 AI 模型分析。',
  '请重点分析 changeType=added 以及 pageType=unknown 的条目，并回答：1) 是否为新的游戏页面；2) 游戏名称；3) 游戏类型；4) 是否值得建立独立 SEO 页面；5) 是否有发布时间或热点证据；6) 判断置信度；7) 是否需要人工复核。',
  ...AI_REVIEW_WARNINGS,
];

/** 把 report.js 里已经算好的 added/missing/consecutive_missing/restored 行合并成统一的 items 数组。 */
export function buildAiReviewItems({ addedRows, changeRows }) {
  const addedItems = addedRows.map((r) => ({
    siteId: r.site_id,
    domain: r.domain,
    url: r.original_url,
    normalizedUrl: r.normalized_url,
    changeType: 'added',
    detectedAt: r.detected_at,
    pageType: r.page_type || null,
    gameName: r.game_name || null,
    confidence: r.confidence || null,
    evidence: r.evidence && r.evidence.length ? r.evidence : null,
    classificationError: r.classification_error || null,
  }));
  const changeItems = changeRows.map((r) => ({
    siteId: r.site_id,
    domain: r.domain,
    url: r.original_url,
    normalizedUrl: r.normalized_url,
    changeType: r.change_type, // missing | consecutive_missing | restored
    detectedAt: r.detected_at,
    pageType: null,
    gameName: null,
    confidence: null,
    evidence: null,
    classificationError: null,
  }));
  return [...addedItems, ...changeItems];
}

export function buildManifest({ runId, generatedAt, runInfo, summary, includedFiles }) {
  return {
    schemaVersion: '1.0',
    generatedAt,
    run: { runId, ...runInfo },
    summary,
    includedFiles,
    warnings: AI_REVIEW_WARNINGS,
  };
}

export function buildAiReviewJson({ runId, runInfo, summary, items }) {
  return {
    schemaVersion: '1.0',
    instructions: AI_REVIEW_INSTRUCTIONS,
    run: { runId, ...runInfo },
    summary,
    items,
  };
}

export function buildAiReviewTxt({ runId, runInfo, summary, items, siteRuns }) {
  const byType = (t) => items.filter((i) => i.changeType === t);
  const added = byType('added');
  const missing = byType('missing');
  const consecutiveMissing = byType('consecutive_missing');
  const restored = byType('restored');
  const unknownAdded = added.filter((i) => i.pageType === 'unknown');
  const failedSites = siteRuns.filter((s) => s.status !== 'success');
  const modeLabel =
    runInfo.mode === 'selected'
      ? `选中站点(${(runInfo.selectedSiteIds || []).join(', ') || '无'})`
      : runInfo.mode === 'all'
        ? '全部站点'
        : '未知';

  const lines = [
    'Sitemap变化AI审查任务',
    '',
    '请重点分析新增URL和unknown URL，并回答：',
    '',
    '1. 是否为新的游戏页面；',
    '2. 游戏名称；',
    '3. 游戏类型；',
    '4. 是否值得建立独立SEO页面；',
    '5. 是否有发布时间或热点证据；',
    '6. 判断置信度；',
    '7. 是否需要人工复核。',
    '',
    '注意：',
    '- missing不等于永久删除；',
    '- consecutive_missing不等于永久删除；',
    '- restored不是新增；',
    '- baseline不是新增；',
    '- partial和failed站点可能不完整。',
    '',
    '## 1. 运行摘要',
    `run_id: ${runId}`,
    `运行时间: ${runInfo.startedAt || '?'} → ${runInfo.finishedAt || '(未记录)'}`,
    `运行模式: ${modeLabel}`,
    `总站点数: ${summary.totalSites}，成功/部分/失败: ${summary.success}/${summary.partial}/${summary.failed}`,
    `新增: ${summary.added}，本轮缺失: ${summary.missing}，连续两轮缺失: ${summary.consecutiveMissing}，恢复: ${summary.restored}`,
    `分类: game ${summary.game} / non_game ${summary.nonGame} / unknown ${summary.unknown}`,
    '',
    '## 2. 新增URL',
    ...formatItemList(added),
    '',
    '## 3. 未知URL',
    ...formatItemList(unknownAdded),
    '',
    '## 4. 本轮缺失',
    ...formatItemList(missing),
    '',
    '## 5. 连续两轮缺失',
    ...formatItemList(consecutiveMissing),
    '',
    '## 6. 恢复URL',
    ...formatItemList(restored),
    '',
    '## 7. partial/failed站点',
    ...(failedSites.length
      ? failedSites.map((s) => `- ${s.site_id}: ${s.status}${s.error_summary ? ` - ${s.error_summary}` : ''}`)
      : ['（无）']),
    '',
  ];
  return lines.join('\n');
}

function formatItemList(items) {
  if (items.length === 0) return ['（无）'];
  return items.map((i) => {
    const extra = i.changeType === 'added' ? ` | pageType=${i.pageType ?? '待分类'} gameName=${i.gameName ?? '-'} confidence=${i.confidence ?? '-'}` : '';
    return `- [${i.siteId}] ${i.url}${extra}`;
  });
}
