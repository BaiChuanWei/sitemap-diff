// Sitemap 监控面板前端。原生 DOM，无框架，无构建步骤。
// 安全原则：所有来自服务端的数据一律用 textContent 赋值，不使用 innerHTML
// 拼接，避免 Sitemap URL / 页面标题 / notes 里可能出现的恶意内容被当作
// HTML 执行。

const STATUS_LABEL = {
  success: '成功', partial: '部分成功', failed: '失败', running: '进行中',
  cancelled: '已停止', waiting: '等待',
};

const RUN_PHASE_LABEL = {
  preparing: '准备中', collecting: '采集中', classifying: '正在分类',
  reporting: '正在生成报告', completed: '已完成', failed: '运行失败', cancelled: '已安全停止',
};

const state = {
  sessionToken: null,
  allSites: [],
  page: 1,
  pageSize: 20,
  editingSiteId: null, // null = 新增模式
  formConfigVersion: undefined,
  selectedSiteIds: new Set(), // 站点管理页"运行选中站点"用
  run: {
    viewingRunId: null, // 当前"实时运行"页正在展示的 run_id（活动中或刚结束）
    refreshInFlight: false,
    refreshQueued: false,
  },
};

// ---- 基础请求封装 ----

async function fetchJson(path) {
  const res = await fetch(path, { headers: { host: location.host } });
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    throw apiErrorFrom(res, body);
  }
  return body.data;
}

async function apiMutate(path, method, payload) {
  const res = await fetch(path, {
    method,
    headers: {
      host: location.host,
      'content-type': 'application/json',
      origin: location.origin,
      'x-dashboard-token': state.sessionToken || '',
    },
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    throw apiErrorFrom(res, body);
  }
  return body.data;
}

function apiErrorFrom(res, body) {
  const err = new Error(body?.error?.message || `请求失败 (HTTP ${res.status})`);
  err.code = body?.error?.code;
  err.fieldErrors = body?.error?.fieldErrors;
  err.status = res.status;
  // 极少数错误（如 RUN_ALREADY_ACTIVE）会在 error 对象上直接带业务字段
  // （activeRunId），完整保留整个 error 对象，调用方按需读取。
  err.details = body?.error || {};
  return err;
}

function el(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusBadge(status) {
  return el('span', { className: `status-badge status-${status || 'unknown'}`, text: STATUS_LABEL[status] || status || '未知' });
}

function formatBytes(bytes) {
  if (bytes == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function formatTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso;
  }
}

// ---- Tabs ----

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchToTab(btn.dataset.tab));
  });
}

function switchToTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-page').forEach((p) => (p.hidden = true));
  document.getElementById(`tab-${tab}`).hidden = false;
  if (tab === 'sites') loadSiteManageList();
  if (tab === 'run') refreshRunView();
}

// ---- 总览 / 运行历史（沿用 M1） ----

async function loadOverview() {
  const container = document.getElementById('overview-cards');
  try {
    const data = await fetchJson('/api/overview');
    container.replaceChildren();
    const cards = [
      ['站点总数', data.siteCount],
      ['已启用', data.enabledCount],
      ['已建立 baseline', data.baselineCount],
      ['历史 URL 总数', data.seenUrlCount],
      ['累计新增 URL', data.addedUrlCount],
      ['今日新增 URL', data.todayAddedUrlCount],
      ['今日新游戏', data.todayNewGameCount],
      ['数据库大小', formatBytes(data.dbSizeBytes)],
    ];
    for (const [label, value] of cards) {
      const card = el('div', { className: 'card' });
      card.append(el('div', { className: 'label', text: label }), el('div', { className: 'value', text: String(value ?? '-') }));
      container.append(card);
    }
    const noticeEl = document.getElementById('stale-run-notice');
    if (data.staleRunningRun) {
      noticeEl.hidden = false;
      noticeEl.textContent = `检测到一次未正常结束的运行记录（run_id=${data.staleRunningRun.run_id}，开始于 ${formatTime(data.staleRunningRun.started_at)}），可能是服务被意外中断导致。该记录不会自动修改，仅供参考。`;
    } else {
      noticeEl.hidden = true;
    }
  } catch (err) {
    container.replaceChildren(el('p', { className: 'muted', text: `加载失败：${err.message}` }));
  }
}

async function loadRuns() {
  const tbody = document.querySelector('#runs-table tbody');
  try {
    const { runs } = await fetchJson('/api/runs?limit=20');
    tbody.replaceChildren();
    if (runs.length === 0) {
      tbody.append(rowWithMessage(5, '暂无运行历史'));
      return;
    }
    for (const r of runs) {
      const tr = el('tr');
      tr.append(
        el('td', { text: r.run_id }),
        el('td', { text: formatTime(r.started_at) }),
        wrapCell(statusBadge(r.status)),
        el('td', { text: `${r.sites_success ?? 0} / ${r.sites_partial ?? 0} / ${r.sites_failed ?? 0}` }),
        el('td', { text: String(r.added_url_count ?? 0) }),
      );
      tbody.append(tr);
    }
  } catch (err) {
    tbody.replaceChildren(rowWithMessage(5, `加载失败：${err.message}`));
  }
}

function wrapCell(child) {
  const td = el('td');
  td.append(child);
  return td;
}
function rowWithMessage(colspan, message) {
  const tr = el('tr');
  const td = el('td', { className: 'muted', text: message });
  td.colSpan = colspan;
  tr.append(td);
  return tr;
}

// ---- 站点管理：列表 ----

async function loadSiteManageList() {
  const tbody = document.querySelector('#site-manage-table tbody');
  try {
    const { sites } = await fetchJson('/api/sites');
    state.allSites = sites;
    state.page = 1;
    renderSiteList();
  } catch (err) {
    tbody.replaceChildren(rowWithMessage(11, `加载失败：${err.message}`));
  }
}

function getFilteredSites() {
  const search = document.getElementById('site-search').value.trim().toLowerCase();
  const enabledFilter = document.getElementById('site-filter-enabled').value;
  const statusFilter = document.getElementById('site-filter-status').value;
  const priorityFilter = document.getElementById('site-filter-priority').value;

  return state.allSites.filter((s) => {
    if (search && !s.site_id.toLowerCase().includes(search) && !(s.domain || '').toLowerCase().includes(search)) return false;
    if (enabledFilter && String(!!s.enabled) !== enabledFilter) return false;
    if (statusFilter && s.last_status !== statusFilter) return false;
    if (priorityFilter && s.priority !== priorityFilter) return false;
    return true;
  });
}

function renderSiteList() {
  const tbody = document.querySelector('#site-manage-table tbody');
  const filtered = getFilteredSites();
  document.getElementById('site-result-count').textContent = `共 ${filtered.length} 个站点`;

  // 之前选中的站点如果被筛选条件挡住了，不清空选择——切换筛选条件不应该
  // 悄悄丢掉用户已经勾选的站点；只有站点本身被暂停/删除才会失效。
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const pageItems = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

  tbody.replaceChildren();
  if (pageItems.length === 0) {
    tbody.append(rowWithMessage(12, '没有符合条件的站点'));
  }
  for (const s of pageItems) {
    const tr = el('tr');
    const checkboxTd = el('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = !s.enabled; // 已暂停站点不允许被选中运行
    checkbox.checked = state.selectedSiteIds.has(s.site_id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedSiteIds.add(s.site_id);
      else state.selectedSiteIds.delete(s.site_id);
      updateSelectedCount();
    });
    checkboxTd.append(checkbox);
    tr.append(
      checkboxTd,
      el('td', { text: s.enabled ? '是' : '暂停' }),
      el('td', { text: s.site_id }),
      el('td', { text: s.domain || '-' }),
      el('td', { text: s.priority || '-' }),
      wrapCell(statusBadge(s.last_status)),
      el('td', { text: formatTime(s.last_success_at) }),
      el('td', { text: s.last_error || '-' }),
      el('td', { text: s.baseline_completed_at ? formatTime(s.baseline_completed_at) : '未建立' }),
      el('td', { text: '查看详情可见' }),
      el('td', { text: '查看详情可见' }),
    );
    const actionsTd = el('td');
    const viewBtn = el('button', { text: '查看/编辑' });
    viewBtn.addEventListener('click', () => openSiteDetail(s.site_id));
    actionsTd.append(viewBtn);
    tr.append(actionsTd);
    tbody.append(tr);
  }
  renderPagination(totalPages);
  updateSelectAllCheckbox(filtered);
  updateSelectedCount();
}

/** "全选"复选框：选中/清空当前筛选结果里全部可选（已启用）的站点，不受分页影响。 */
function updateSelectAllCheckbox(filtered) {
  const selectAll = document.getElementById('site-select-all');
  const selectable = filtered.filter((s) => s.enabled);
  const allSelected = selectable.length > 0 && selectable.every((s) => state.selectedSiteIds.has(s.site_id));
  selectAll.checked = allSelected;
  selectAll.disabled = selectable.length === 0;
  selectAll.onchange = () => {
    if (selectAll.checked) selectable.forEach((s) => state.selectedSiteIds.add(s.site_id));
    else selectable.forEach((s) => state.selectedSiteIds.delete(s.site_id));
    renderSiteList();
  };
}

function updateSelectedCount() {
  document.getElementById('site-selected-count').textContent = `已选择 ${state.selectedSiteIds.size} 个站点`;
}

function renderPagination(totalPages) {
  const container = document.getElementById('site-pagination');
  container.replaceChildren();
  if (totalPages <= 1) return;
  for (let p = 1; p <= totalPages; p++) {
    const btn = el('button', { text: String(p), className: p === state.page ? 'page-btn active' : 'page-btn' });
    btn.addEventListener('click', () => {
      state.page = p;
      renderSiteList();
    });
    container.append(btn);
  }
}

function setupSiteListControls() {
  ['site-search', 'site-filter-enabled', 'site-filter-status', 'site-filter-priority'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      state.page = 1;
      renderSiteList();
    });
  });
  document.getElementById('btn-new-site').addEventListener('click', () => openSiteForm(null));
  document.getElementById('btn-run-selected').addEventListener('click', onRunSelectedClick);
}

async function onRunSelectedClick() {
  const siteIds = Array.from(state.selectedSiteIds);
  if (siteIds.length === 0) {
    alert('请先在列表里勾选至少一个站点。');
    return;
  }
  const preview = siteIds.length > 10 ? `${siteIds.slice(0, 10).join('、')} 等共 ${siteIds.length} 个站点` : siteIds.join('、');
  const confirmed = confirm(`即将运行选中的 ${siteIds.length} 个站点：\n${preview}\n\n是否继续？`);
  if (!confirmed) return;
  await startRun({ mode: 'selected', siteIds });
}

// ---- 站点管理：新增/编辑表单 ----

function showPanel(id) {
  ['site-list-panel', 'site-form-panel', 'site-detail-panel'].forEach((p) => {
    document.getElementById(p).hidden = p !== id;
  });
}

function openSiteForm(siteId) {
  state.editingSiteId = siteId;
  document.getElementById('site-form-title').textContent = siteId ? `编辑站点：${siteId}` : '新增站点';
  document.getElementById('site-form-error').hidden = true;
  document.getElementById('site-form-success').hidden = true;
  document.getElementById('site-form-preview').hidden = true;
  document.getElementById('site-form').hidden = false;
  document.getElementById('btn-preview-site').hidden = false;
  document.getElementById('btn-confirm-save-site').hidden = true;

  const idField = document.getElementById('field-site-id');
  if (siteId) {
    const site = state.allSites.find((s) => s.site_id === siteId);
    idField.value = siteId;
    idField.disabled = true;
    document.getElementById('field-domain').value = site?.domain || '';
    document.getElementById('field-priority').value = site?.priority || 'medium';
    document.getElementById('field-enabled').checked = !!site?.enabled;
    document.getElementById('field-robots-url').value = site?.robots_url || '';
    document.getElementById('field-sitemap-url').value = site?.sitemap_url || '';
    document.getElementById('field-expected-game-path').value = site?.expected_game_path || '';
    document.getElementById('field-site-category').value = site?.site_category || '';
    document.getElementById('field-notes').value = site?.notes || '';
  } else {
    idField.value = '';
    idField.disabled = false;
    document.getElementById('site-form').reset();
  }
  showPanel('site-form-panel');
}

function readSiteFormValues() {
  const domain = document.getElementById('field-domain').value.trim();
  const robotsUrlRaw = document.getElementById('field-robots-url').value.trim();
  return {
    site_id: document.getElementById('field-site-id').value.trim(),
    domain,
    priority: document.getElementById('field-priority').value,
    enabled: document.getElementById('field-enabled').checked,
    robots_url: robotsUrlRaw || (domain ? `https://${domain}/robots.txt` : ''),
    sitemap_url: document.getElementById('field-sitemap-url').value.trim(),
    expected_game_path: document.getElementById('field-expected-game-path').value.trim(),
    site_category: document.getElementById('field-site-category').value.trim(),
    notes: document.getElementById('field-notes').value,
  };
}

function showFormError(message, fieldErrors) {
  const box = document.getElementById('site-form-error');
  box.replaceChildren();
  box.append(el('p', { text: message }));
  if (fieldErrors) {
    const ul = document.createElement('ul');
    for (const [field, msg] of Object.entries(fieldErrors)) {
      ul.append(el('li', { text: `${field}: ${msg}` }));
    }
    box.append(ul);
  }
  box.hidden = false;
}

function setupSiteForm() {
  document.getElementById('btn-cancel-site-form').addEventListener('click', () => {
    showPanel('site-list-panel');
  });
  document.getElementById('btn-close-detail').addEventListener('click', () => showPanel('site-list-panel'));
  document.getElementById('btn-back-to-list').addEventListener('click', () => {
    showPanel('site-list-panel');
    loadSiteManageList();
  });

  document.getElementById('btn-preview-site').addEventListener('click', async () => {
    document.getElementById('site-form-error').hidden = true;
    const values = readSiteFormValues();
    try {
      // 在预览这一刻拍下 configVersion 快照，确认保存时必须用这个版本号，
      // 而不是提交时重新拉取最新版本——否则如果另一个标签页在"预览"和
      // "确认保存"之间改动了配置，这里会悄悄用最新版本覆盖掉对方的修改，
      // 而不是把冲突暴露给用户（见 M2 对抗场景：两个标签页同时保存）。
      state.formConfigVersion = await currentSitesConfigVersion();
    } catch {
      // 拿不到就置为 undefined——服务端把 undefined 当作"不做版本校验"，
      // 不能传一个错误的占位值（比如 null）导致后续保存必然被误判为冲突。
      state.formConfigVersion = undefined;
    }
    const preview = document.getElementById('site-form-preview-content');
    preview.textContent = JSON.stringify(values, null, 2);
    document.getElementById('site-form-preview').hidden = false;
    document.getElementById('btn-preview-site').hidden = true;
    document.getElementById('btn-confirm-save-site').hidden = false;
  });

  document.getElementById('btn-confirm-save-site').addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirm-save-site');
    if (btn.disabled) return; // 防止连续点击重复提交
    btn.disabled = true;
    btn.textContent = '保存中...';
    document.getElementById('site-form-error').hidden = true;
    try {
      const values = readSiteFormValues();
      // 用预览时拍下的版本号，不在这里重新拉取——重新拉取会让"两个标签页
      // 同时保存"这种场景永远拿到最新版本、永远不冲突，等于没做并发保护。
      const version = state.formConfigVersion;
      let result;
      if (state.editingSiteId) {
        const { site_id, ...patchBody } = values;
        result = await apiMutate(`/api/sites/${encodeURIComponent(state.editingSiteId)}`, 'PATCH', { ...patchBody, expectedConfigVersion: version });
      } else {
        result = await apiMutate('/api/sites', 'POST', { ...values, expectedConfigVersion: version });
      }
      // 只有服务端确认落盘成功（走到这里）才展示"保存成功"，不做乐观更新。
      document.getElementById('site-form').hidden = true;
      document.getElementById('site-form-success').hidden = false;
      state.lastSavedSiteId = state.editingSiteId || values.site_id;
    } catch (err) {
      if (err.code === 'CONFIG_VERSION_CONFLICT') {
        showFormError('配置已被其他操作修改，请刷新后重试。');
      } else if (err.status === 422) {
        showFormError('表单校验未通过，请检查以下字段：', err.fieldErrors);
      } else {
        showFormError(`保存失败：${err.message}`);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '确认保存';
    }
  });

  document.getElementById('btn-diagnose-after-save').addEventListener('click', () => {
    showPanel('site-list-panel');
    loadSiteManageList().then(() => openSiteDetail(state.lastSavedSiteId));
  });
}

async function currentSitesConfigVersion() {
  // 任意一个只读配置接口都会带上当前 configVersion；用第一个站点详情接口
  // 拿版本号太绕，这里统一走 /api/sites/<任意已知站点>/limits，若列表为空
  // 则退化为不带 expectedConfigVersion（服务端允许，新库首次写入场景）。
  if (state.allSites.length === 0) return undefined;
  try {
    const data = await fetchJson(`/api/sites/${encodeURIComponent(state.allSites[0].site_id)}/limits`);
    return data.configVersion;
  } catch {
    return undefined;
  }
}

// ---- 站点详情（编辑入口 + 暂停/启用 + 限制 + 手工Sitemap + 诊断） ----

async function openSiteDetail(siteId) {
  showPanel('site-detail-panel');
  document.getElementById('site-detail-title').textContent = `站点详情：${siteId}`;
  const content = document.getElementById('site-detail-content');
  content.replaceChildren(el('p', { className: 'muted', text: '加载中...' }));
  try {
    const detail = await fetchJson(`/api/sites/${encodeURIComponent(siteId)}`);
    renderSiteDetail(siteId, detail);
  } catch (err) {
    content.replaceChildren(el('p', { className: 'muted', text: `加载失败：${err.message}` }));
  }
}

function renderSiteDetail(siteId, detail) {
  const content = document.getElementById('site-detail-content');
  content.replaceChildren();

  const basic = el('div', { className: 'detail-block' });
  basic.append(el('h3', { text: '基础信息' }));
  const table = document.createElement('table');
  const rows = [
    ['域名', detail.config.domain],
    ['优先级', detail.config.priority],
    ['启用', detail.config.enabled === 'true' ? '是' : '暂停'],
    ['robots.txt', detail.config.robots_url || '-'],
    ['单一 Sitemap', detail.config.sitemap_url || '-'],
    ['备注', detail.config.notes || '-'],
    ['最近状态', detail.runtime?.last_status || '-'],
    ['最近成功', formatTime(detail.runtime?.last_success_at)],
    ['最近错误', detail.runtime?.last_error || '-'],
    ['baseline', detail.runtime?.baseline_completed_at ? formatTime(detail.runtime.baseline_completed_at) : '未建立'],
  ];
  for (const [label, value] of rows) {
    const tr = document.createElement('tr');
    tr.append(el('th', { text: label }), el('td', { text: value }));
    table.append(tr);
  }
  basic.append(table);

  const actions = el('div', { className: 'form-actions' });
  const editBtn = el('button', { text: '编辑', className: 'btn-primary' });
  editBtn.addEventListener('click', () => openSiteForm(siteId));
  const toggleBtn = el('button', { text: detail.config.enabled === 'true' ? '暂停监控' : '启用监控' });
  toggleBtn.addEventListener('click', () => toggleSiteEnabled(siteId, detail.config.enabled !== 'true'));
  actions.append(editBtn, toggleBtn);
  basic.append(actions);
  content.append(basic);

  // 站点级限制
  const limitsBlock = el('div', { className: 'detail-block' });
  limitsBlock.append(el('h3', { text: '站点级限制（可选，留空使用默认值）' }));
  limitsBlock.append(buildLimitsForm(siteId));
  content.append(limitsBlock);

  // 手工 Sitemap
  const sitemapsBlock = el('div', { className: 'detail-block' });
  sitemapsBlock.append(el('h3', { text: '手工 Sitemap' }));
  sitemapsBlock.append(buildSitemapsForm(siteId, detail.sitemaps));
  content.append(sitemapsBlock);

  // 诊断
  const diagBlock = el('div', { className: 'detail-block' });
  diagBlock.append(el('h3', { text: '只读诊断' }));
  const diagBtn = el('button', { text: '运行诊断', className: 'btn-primary' });
  const diagResult = el('div', { className: 'diagnose-result' });
  diagBtn.addEventListener('click', () => runDiagnosis(siteId, diagBtn, diagResult));
  diagBlock.append(diagBtn, diagResult);
  content.append(diagBlock);
}

async function toggleSiteEnabled(siteId, enable) {
  if (!enable) {
    const confirmed = confirm(`确定要暂停监控「${siteId}」吗？\n\n暂停不会删除任何历史数据（baseline / 历史URL / 运行记录都会保留），随时可以重新启用。`);
    if (!confirmed) return;
  }
  try {
    const version = await currentSitesConfigVersion();
    await apiMutate(`/api/sites/${encodeURIComponent(siteId)}/${enable ? 'enable' : 'disable'}`, 'POST', { expectedConfigVersion: version });
    await loadSiteManageList();
    openSiteDetail(siteId);
  } catch (err) {
    alert(`操作失败：${err.message}`);
  }
}

function buildLimitsForm(siteId) {
  const container = el('div');
  container.append(el('p', { className: 'muted', text: '加载中...' }));
  fetchJson(`/api/sites/${encodeURIComponent(siteId)}/limits`)
    .then((data) => {
      container.replaceChildren();
      const fields = [
        ['max_download_bytes', '单文件下载大小上限', 'bytes', 100 * 1024 * 1024],
        ['max_decompressed_bytes', 'Gzip 解压后大小上限', 'bytes', 250 * 1024 * 1024],
        ['max_page_urls', '页面 URL 数量上限', '个', 1500000],
        ['max_sitemap_endpoints', 'Sitemap Endpoint 数量上限', '个', 1000],
        ['max_depth', '递归深度上限', '层', 10],
        ['request_timeout_ms', '单次请求超时', 'ms', 60000],
      ];
      const form = document.createElement('div');
      const inputs = {};
      for (const [field, label, unit, hardCap] of fields) {
        const row = el('div', { className: 'form-row' });
        row.append(el('label', { text: `${label}（硬上限 ${hardCap.toLocaleString()} ${unit}）` }));
        const input = document.createElement('input');
        input.type = 'number';
        input.value = data.values[field] || '';
        input.placeholder = '留空 = 使用系统默认值';
        inputs[field] = input;
        row.append(input);
        const readable = el('p', { className: 'field-hint readable-value' });
        updateReadableValue(readable, field, input.value, unit);
        input.addEventListener('input', () => updateReadableValue(readable, field, input.value, unit));
        row.append(readable);
        form.append(row);
      }
      const saveBtn = el('button', { text: '保存限制', className: 'btn-primary' });
      const errorBox = el('div', { className: 'form-error', text: '' });
      errorBox.hidden = true;
      saveBtn.addEventListener('click', async () => {
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        errorBox.hidden = true;
        try {
          const payload = {};
          for (const [field] of fields) payload[field] = inputs[field].value ? Number(inputs[field].value) : '';
          const version = await currentSitesConfigVersion();
          await apiMutate(`/api/sites/${encodeURIComponent(siteId)}/limits`, 'PUT', { ...payload, expectedConfigVersion: version });
          alert('站点限制已保存。');
        } catch (err) {
          errorBox.textContent = err.code === 'CONFIG_VERSION_CONFLICT' ? '配置已被其他操作修改，请刷新后重试。' : `保存失败：${err.message}`;
          errorBox.hidden = false;
        } finally {
          saveBtn.disabled = false;
        }
      });
      form.append(errorBox, saveBtn);
      container.append(form);
    })
    .catch((err) => {
      container.replaceChildren(el('p', { className: 'muted', text: `加载失败：${err.message}` }));
    });
  return container;
}

function updateReadableValue(node, field, rawValue, unit) {
  const n = Number(rawValue);
  if (!rawValue || Number.isNaN(n)) {
    node.textContent = '当前：使用系统默认值';
    return;
  }
  if (unit === 'bytes') {
    node.textContent = `当前：${n.toLocaleString()} bytes（约 ${formatBytes(n)}）`;
  } else {
    node.textContent = `当前：${n.toLocaleString()} ${unit}`;
  }
}

function buildSitemapsForm(siteId, initialRows) {
  const container = el('div');
  const modeSelect = document.createElement('select');
  ['merge', 'manual_only'].forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modeSelect.append(opt);
  });
  modeSelect.value = initialRows[0]?.mode || 'merge';
  const modeRow = el('div', { className: 'form-row' });
  modeRow.append(el('label', { text: 'discovery mode' }), modeSelect);
  container.append(modeRow);

  const rowsContainer = document.createElement('div');
  const rows = [];

  function addRow(prefill) {
    const rowEl = el('div', { className: 'sitemap-row' });
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://example.com/sitemap.xml';
    urlInput.value = prefill?.sitemap_url || '';
    const enabledLabel = document.createElement('label');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = prefill ? !!prefill.enabled : true;
    enabledLabel.append(enabledInput, document.createTextNode(' 启用'));
    const removeBtn = el('button', { text: '移除' });
    removeBtn.addEventListener('click', () => {
      rowEl.remove();
      const idx = rows.indexOf(entry);
      if (idx >= 0) rows.splice(idx, 1);
    });
    rowEl.append(urlInput, enabledLabel, removeBtn);
    rowsContainer.append(rowEl);
    const entry = { urlInput, enabledInput };
    rows.push(entry);
  }

  for (const r of initialRows) addRow(r);
  container.append(rowsContainer);

  const addBtn = el('button', { text: '+ 添加 Endpoint' });
  addBtn.addEventListener('click', () => addRow(null));
  container.append(addBtn);

  const errorBox = el('div', { className: 'form-error' });
  errorBox.hidden = true;
  const saveBtn = el('button', { text: '保存手工 Sitemap', className: 'btn-primary' });
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    errorBox.hidden = true;
    try {
      const urls = rows
        .map((r) => ({ sitemap_url: r.urlInput.value.trim(), enabled: r.enabledInput.checked }))
        .filter((r) => r.sitemap_url);
      const version = await currentSitesConfigVersion();
      await apiMutate(`/api/sites/${encodeURIComponent(siteId)}/sitemaps`, 'PUT', { mode: modeSelect.value, urls, expectedConfigVersion: version });
      alert('手工 Sitemap 已保存。');
    } catch (err) {
      errorBox.textContent =
        err.code === 'CONFIG_VERSION_CONFLICT' ? '配置已被其他操作修改，请刷新后重试。' : `保存失败：${err.message}${err.fieldErrors ? ' - ' + JSON.stringify(err.fieldErrors) : ''}`;
      errorBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });
  container.append(errorBox, saveBtn);
  return container;
}

// ---- 诊断 ----

const diagnosisInFlight = new Set();

async function runDiagnosis(siteId, btn, resultEl) {
  if (diagnosisInFlight.has(siteId)) return; // 防止同站重复诊断
  diagnosisInFlight.add(siteId);
  btn.disabled = true;
  btn.textContent = '诊断运行中...';
  resultEl.replaceChildren(el('p', { className: 'muted', text: '诊断中，可能需要几十秒（大站点更久）...' }));
  try {
    const start = await apiMutate(`/api/sites/${encodeURIComponent(siteId)}/diagnose`, 'POST', {});
    const result = await pollDiagnosis(start.diagnosticId);
    renderDiagnosisResult(resultEl, result);
  } catch (err) {
    resultEl.replaceChildren(el('p', { className: 'form-error', text: `诊断失败：${err.message}` }));
  } finally {
    diagnosisInFlight.delete(siteId);
    btn.disabled = false;
    btn.textContent = '运行诊断';
  }
}

async function pollDiagnosis(diagnosticId, { intervalMs = 1000, maxAttempts = 120 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const data = await fetchJson(`/api/diagnostics/${diagnosticId}`);
    if (data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('诊断超时，请稍后在诊断结果里重新查看');
}

function renderDiagnosisResult(container, entry) {
  container.replaceChildren();
  if (entry.status === 'failed') {
    container.append(el('p', { className: 'form-error', text: `诊断执行出错：${entry.error}` }));
    return;
  }
  const r = entry.result;
  const table = document.createElement('table');
  const rows = [
    ['discovery mode', r.discoveryMode],
    ['首页状态', r.homepage ? `HTTP ${r.homepage.httpStatus ?? '(无响应)'}` : '-'],
    ['robots.txt', r.robots ? `HTTP ${r.robots.httpStatus ?? '(无响应)'}` : '-'],
    ['Endpoint 数量', r.endpointCount],
    ['页面 URL 数量', r.pageUrlCount],
    ['状态', r.status],
    ['complete', String(r.complete)],
    ['truncated', String(r.truncated)],
    ['截断原因', (r.truncationReasons || []).join(', ') || '-'],
    ['错误码', r.errorCode || '-'],
    ['推荐处理', r.recommendedAction],
  ];
  for (const [label, value] of rows) {
    const tr = document.createElement('tr');
    tr.append(el('th', { text: label }), el('td', { text: String(value) }));
    table.append(tr);
  }
  container.append(table);
}

// ---- 实时运行 ----
//
// 设计原则（对应 M3 需求"前端不得单纯通过事件累加统计，服务端快照和
// SQLite 是最终事实来源"）：SSE 事件只是"该刷新了"的信号，不携带任何
// 前端用来累加/拼装状态的数据本身——收到任意运行相关事件后，一律重新
// GET /api/runs/active + /api/runs/:id/sites 拿权威状态再整体重渲染，
// 不在前端维护一份"自己算出来的"运行统计。

const RUN_EVENT_NAMES = [
  'run_started', 'run_phase_changed', 'site_started', 'sitemap_discovered', 'site_finished',
  'classification_started', 'classification_finished', 'report_generated',
  'run_cancel_requested', 'run_cancelled', 'run_finished', 'run_failed',
];

function setupRunTabControls() {
  document.getElementById('btn-start-all-overview').addEventListener('click', onStartAllClick);
  document.getElementById('btn-start-all-run-tab').addEventListener('click', onStartAllClick);
  document.getElementById('btn-close-changes').addEventListener('click', () => showRunPanel('run-active-panel'));
  ['run-site-search', 'run-site-filter-status'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => applyRunSitesFilter());
  });
  document.getElementById('run-site-filter-added').addEventListener('change', () => applyRunSitesFilter());
}

function showRunPanel(id) {
  ['run-idle-panel', 'run-active-panel', 'run-changes-panel'].forEach((p) => {
    document.getElementById(p).hidden = p !== id;
  });
}

/** 协作式刷新：避免同一时刻堆积多个并发的 /api/runs/active 请求。 */
async function refreshRunView() {
  if (state.run.refreshInFlight) {
    state.run.refreshQueued = true;
    return;
  }
  state.run.refreshInFlight = true;
  try {
    await doRefreshRunView();
  } finally {
    state.run.refreshInFlight = false;
    if (state.run.refreshQueued) {
      state.run.refreshQueued = false;
      refreshRunView();
    }
  }
}

async function doRefreshRunView() {
  if (document.getElementById('tab-run').hidden) return; // 没在看这个 tab 就不用渲染，省一次 DOM 更新
  let active = null;
  try {
    ({ active } = await fetchJson('/api/runs/active'));
  } catch {
    return;
  }

  if (active) {
    state.run.viewingRunId = active.runId;
    let sites = [];
    try {
      ({ sites } = await fetchJson(`/api/runs/${encodeURIComponent(active.runId)}/sites`));
    } catch {
      sites = [];
    }
    renderRunActive(active, sites);
    return;
  }

  if (state.run.viewingRunId) {
    await renderRunFinished(state.run.viewingRunId);
    return;
  }

  await renderRunIdle();
}

async function renderRunIdle() {
  showRunPanel('run-idle-panel');
  document.getElementById('run-cancel-status').hidden = true;

  const staleNotice = document.getElementById('run-stale-notice');
  const lastSummaryEl = document.getElementById('run-last-summary');
  try {
    const overview = await fetchJson('/api/overview');
    if (overview.staleRunningRun) {
      staleNotice.hidden = false;
      staleNotice.textContent =
        `上次运行异常中断（run_id=${overview.staleRunningRun.run_id}，开始于 ${formatTime(overview.staleRunningRun.started_at)}）。` +
        '该记录不会自动继续，也不会被当作已完成，可以直接点击下方按钮开始新的运行。';
    } else {
      staleNotice.hidden = true;
    }
  } catch {
    staleNotice.hidden = true;
  }

  // 展示"最近一次运行"（不限模式）+ 一个能直接打开详情/报告的入口——
  // 用户刷新页面或关闭重开浏览器时，不能因为运行已经结束就找不到刚才的
  // 结果，"最终结果在哪里"是这个页面必须回答的问题之一。
  lastSummaryEl.replaceChildren();
  try {
    const { runs } = await fetchJson('/api/runs?limit=1');
    const lastRun = runs[0];
    if (lastRun && lastRun.finished_at) {
      lastSummaryEl.hidden = false;
      const modeLabel = lastRun.run_mode === 'selected' ? '选中站点' : lastRun.run_mode === 'all' ? '全部站点' : '（命令行触发）';
      lastSummaryEl.append(
        el('p', {
          text: `最近一次运行（${modeLabel}）：${formatTime(lastRun.started_at)}，${STATUS_LABEL[lastRun.status] || lastRun.status}，${lastRun.sites_success}/${lastRun.sites_total} 个站点成功，新增 ${lastRun.added_url_count} 个 URL。`,
        }),
      );
      const viewBtn = el('button', { text: '查看详情/报告' });
      viewBtn.addEventListener('click', () => {
        state.run.viewingRunId = lastRun.run_id;
        renderRunFinished(lastRun.run_id);
      });
      lastSummaryEl.append(viewBtn);
    } else {
      lastSummaryEl.hidden = true;
    }
  } catch {
    lastSummaryEl.hidden = true;
  }
}

async function getLastFullRunSummary() {
  try {
    const { runs } = await fetchJson('/api/runs?limit=10');
    const lastAll = runs.find((r) => r.run_mode === 'all' && r.finished_at);
    if (!lastAll) return null;
    const durationSec = Math.round((new Date(lastAll.finished_at) - new Date(lastAll.started_at)) / 1000);
    return { durationSec, startedAt: lastAll.started_at, sitesSuccess: lastAll.sites_success, sitesTotal: lastAll.sites_total };
  } catch {
    return null;
  }
}

function renderRunActive(active, sites) {
  showRunPanel('run-active-panel');
  document.getElementById('run-report-block').hidden = true;

  const isTerminal = ['completed', 'failed', 'cancelled'].includes(active.phase);
  const phaseLabel = RUN_PHASE_LABEL[active.phase] || active.phase;
  const elapsedSec = Math.max(0, Math.round((Date.now() - new Date(active.startedAt).getTime()) / 1000));

  const cards = document.getElementById('run-header-cards');
  cards.replaceChildren();
  const cardData = [
    ['run_id', active.runId],
    ['阶段', active.cancelRequested && !isTerminal ? `${phaseLabel}（停止请求已提交）` : phaseLabel],
    ['运行模式', active.mode === 'all' ? '全部站点' : '选中站点'],
    ['已运行', `${elapsedSec} 秒`],
    ['总站点', active.stats.sitesTotal],
    ['已完成', active.stats.sitesCompleted ?? 0],
    ['成功 / 部分 / 失败', `${active.stats.sitesSuccess} / ${active.stats.sitesPartial} / ${active.stats.sitesFailed}`],
    ['baseline 站点', active.stats.baselineSiteCount],
    ['新增 URL', active.stats.addedUrlCount],
  ];
  for (const [label, value] of cardData) {
    const card = el('div', { className: 'card' });
    card.append(el('div', { className: 'label', text: label }), el('div', { className: 'value', text: String(value ?? '-') }));
    cards.append(card);
  }

  const total = active.stats.sitesTotal || 0;
  const done = active.stats.sitesCompleted || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('run-progress-bar').style.width = `${pct}%`;
  document.getElementById('run-progress-label').textContent = `已完成 ${done} / ${total}（${pct}%）`;

  // 一旦所有站点采集都已经结束（进入分类/生成报告阶段），"安全停止"就没有
  // 意义了——runCollect 的取消检查只在"开始下一个站点之前"生效，分类和
  // 报告阶段没有可以中途打断的逐条循环。继续显示按钮会让用户以为点了就能
  // 立刻停止，实际上只是安静地等分类/报告跑完，所以这两个阶段直接隐藏
  // 按钮，而不是显示一个点了也没用的按钮。
  const canCancel = !isTerminal && !['classifying', 'reporting'].includes(active.phase);
  const cancelBtn = document.getElementById('btn-cancel-run');
  const cancelStatus = document.getElementById('run-cancel-status');
  cancelBtn.hidden = !canCancel;
  cancelBtn.disabled = active.cancelRequested;
  cancelBtn.onclick = () => cancelActiveRun(active.runId);
  if (active.cancelRequested && !isTerminal) {
    cancelStatus.hidden = false;
    cancelStatus.textContent = '已提交停止请求，当前正在处理的网站完成后停止，不会立即中断网络请求。';
  } else {
    cancelStatus.hidden = true;
  }

  renderRunSitesTable(active.runId, sites);
}

async function renderRunFinished(runId) {
  let detail;
  try {
    detail = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
  } catch {
    // run_id 查不到了（不太可能，但兜底）：回到空闲视图，不留一个死链接的运行页。
    state.run.viewingRunId = null;
    await renderRunIdle();
    return;
  }
  showRunPanel('run-active-panel');
  document.getElementById('run-report-block').hidden = true;

  const run = detail.run;
  const cards = document.getElementById('run-header-cards');
  cards.replaceChildren();
  const cardData = [
    ['run_id', run.run_id],
    ['阶段', RUN_PHASE_LABEL[run.status] || run.status],
    ['运行模式', run.run_mode === 'selected' ? '选中站点' : run.run_mode === 'all' ? '全部站点' : '-'],
    ['开始时间', formatTime(run.started_at)],
    ['结束时间', formatTime(run.finished_at)],
    ['总站点', run.sites_total],
    ['成功 / 部分 / 失败', `${run.sites_success} / ${run.sites_partial} / ${run.sites_failed}`],
    ['baseline 站点', run.baseline_site_count],
    ['新增 URL', run.added_url_count],
  ];
  for (const [label, value] of cardData) {
    const card = el('div', { className: 'card' });
    card.append(el('div', { className: 'label', text: label }), el('div', { className: 'value', text: String(value ?? '-') }));
    cards.append(card);
  }
  document.getElementById('run-progress-bar').style.width = '100%';
  document.getElementById('run-progress-label').textContent = `已完成 ${run.sites_total} / ${run.sites_total}（100%）`;
  document.getElementById('btn-cancel-run').hidden = true;
  document.getElementById('run-cancel-status').hidden = true;

  let sites = [];
  try {
    ({ sites } = await fetchJson(`/api/runs/${encodeURIComponent(runId)}/sites`));
  } catch {
    sites = [];
  }
  renderRunSitesTable(runId, sites);
  await renderRunReportBlock(runId);
}

async function renderRunReportBlock(runId) {
  const block = document.getElementById('run-report-block');
  try {
    const report = await fetchJson(`/api/runs/${encodeURIComponent(runId)}/report`);
    block.hidden = false;
    document.getElementById('run-report-dir').textContent = `报告目录：${report.dir}`;
    document.getElementById('run-report-stats').textContent =
      `新增 ${report.stats.addedTotal}（game ${report.stats.gameCount} / non_game ${report.stats.nonGameCount} / unknown ${report.stats.unknownCount}），分类失败 ${report.stats.classificationErrors}`;
    const list = document.getElementById('run-report-files');
    list.replaceChildren();
    for (const filename of Object.values(report.files)) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/api/runs/${encodeURIComponent(runId)}/report/${encodeURIComponent(filename)}`;
      a.textContent = filename;
      li.append(a);
      list.append(li);
    }
  } catch {
    // 运行被取消、还没跑到报告阶段（REPORT_NOT_READY）等情况：不展示报告区块，
    // 不当成错误提示给用户——本来就没有报告可看。
    block.hidden = true;
  }
}

function renderRunSitesTable(runId, sites) {
  state.run.currentRunId = runId;
  state.run.currentSites = sites;
  applyRunSitesFilter();
}

function applyRunSitesFilter() {
  if (!state.run.currentSites) return;
  const search = document.getElementById('run-site-search').value.trim().toLowerCase();
  const statusFilter = document.getElementById('run-site-filter-status').value;
  const onlyAdded = document.getElementById('run-site-filter-added').checked;
  const runId = state.run.currentRunId;

  const filtered = state.run.currentSites.filter((s) => {
    if (search && !s.siteId.toLowerCase().includes(search) && !(s.domain || '').toLowerCase().includes(search)) return false;
    if (statusFilter && s.status !== statusFilter) return false;
    if (onlyAdded && !(s.addedUrlCount > 0)) return false;
    return true;
  });

  const tbody = document.querySelector('#run-sites-table tbody');
  tbody.replaceChildren();
  if (filtered.length === 0) {
    tbody.append(rowWithMessage(9, '没有符合条件的站点'));
    return;
  }
  for (const s of filtered) {
    const tr = document.createElement('tr');
    const addedTd = el('td', { text: String(s.addedUrlCount ?? 0) });
    if (s.addedUrlCount > 0) addedTd.className = 'has-added';
    tr.append(
      el('td', { text: String(s.index) }),
      el('td', { text: s.domain ? `${s.siteId} (${s.domain})` : s.siteId }),
      wrapCell(statusBadge(s.status)),
      el('td', { text: String(s.pageUrlCount ?? 0) }),
      addedTd,
      el('td', { text: s.isBaseline === true ? '是' : s.isBaseline === false ? '否' : '-' }),
      el('td', { text: s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '-' }),
      el('td', { text: s.errorSummary || '-' }),
    );
    const actionsTd = el('td');
    if (s.addedUrlCount > 0) {
      const btn = el('button', { text: '查看新增' });
      btn.addEventListener('click', () => openRunChanges(runId, s.siteId));
      actionsTd.append(btn);
    }
    tr.append(actionsTd);
    tbody.append(tr);
  }
}

async function cancelActiveRun(runId) {
  const confirmed = confirm(
    '确定要安全停止当前监控任务吗？\n\n当前正在处理的网站会正常完成，不会立即中断网络请求，后续尚未开始的站点将不再调度。',
  );
  if (!confirmed) return;
  try {
    await apiMutate(`/api/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {});
    refreshRunView();
  } catch (err) {
    alert(`停止失败：${err.message}`);
  }
}

async function startRun({ mode, siteIds }) {
  try {
    const payload = mode === 'all' ? { mode: 'all' } : { mode: 'selected', siteIds };
    const result = await apiMutate('/api/runs', 'POST', payload);
    state.run.viewingRunId = result.runId;
    switchToTab('run');
    refreshRunView();
  } catch (err) {
    if (err.code === 'RUN_ALREADY_ACTIVE') {
      // 不是单纯报错，而是直接带用户去看那个正在进行的运行。
      state.run.viewingRunId = err.details.activeRunId || null;
      switchToTab('run');
      refreshRunView();
    } else if (err.status === 422) {
      alert(`站点选择不合法：${err.message}`);
    } else {
      alert(`启动失败：${err.message}`);
    }
  }
}

async function onStartAllClick() {
  let overview = null;
  try {
    overview = await fetchJson('/api/overview');
  } catch {
    // 拿不到也不阻塞，确认框里显示"?"，真正的校验交给服务端。
  }
  const enabledCount = overview ? overview.enabledCount : '?';
  const lastSummary = await getLastFullRunSummary();
  const lastLine = lastSummary
    ? `上次全量运行耗时约 ${lastSummary.durationSec} 秒（${formatTime(lastSummary.startedAt)}）。`
    : '暂无历史全量运行记录。';
  const confirmed = confirm(
    `将监控全部 ${enabledCount} 个已启用站点，是否继续？\n\n` +
      `${lastLine}\n` +
      '站点较多时可能占用较多内存和磁盘空间。\n' +
      '关闭浏览器不会停止后台运行，可以随时重新打开面板查看进度。',
  );
  if (!confirmed) return;
  await startRun({ mode: 'all' });
}

async function openRunChanges(runId, siteId, page = 1) {
  showRunPanel('run-changes-panel');
  document.getElementById('run-changes-title').textContent = `新增 URL：${siteId}`;
  state.run.changesContext = { runId, siteId, page };
  await loadRunChangesPage();
}

async function loadRunChangesPage() {
  const { runId, siteId, page } = state.run.changesContext;
  const tbody = document.querySelector('#run-changes-table tbody');
  tbody.replaceChildren(rowWithMessage(4, '加载中...'));
  try {
    const data = await fetchJson(
      `/api/runs/${encodeURIComponent(runId)}/changes?site_id=${encodeURIComponent(siteId)}&page=${page}&page_size=50`,
    );
    tbody.replaceChildren();
    if (data.items.length === 0) {
      tbody.append(rowWithMessage(4, '没有新增 URL'));
    }
    for (const item of data.items) {
      const tr = document.createElement('tr');
      tr.append(
        el('td', { text: item.originalUrl }),
        el('td', { text: item.pageType }),
        el('td', { text: item.gameName || '-' }),
        el('td', { text: formatTime(item.detectedAt) }),
      );
      tbody.append(tr);
    }
    renderRunChangesPagination(data.total, data.page, data.pageSize);
  } catch (err) {
    tbody.replaceChildren(rowWithMessage(4, `加载失败：${err.message}`));
  }
}

function renderRunChangesPagination(total, page, pageSize) {
  const container = document.getElementById('run-changes-pagination');
  container.replaceChildren();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return;
  for (let p = 1; p <= totalPages; p++) {
    const btn = el('button', { text: String(p), className: p === page ? 'page-btn active' : 'page-btn' });
    btn.addEventListener('click', () => {
      state.run.changesContext.page = p;
      loadRunChangesPage();
    });
    container.append(btn);
  }
}

/** 桌面快捷方式打开 ?action=start-all：点击快捷方式本身就是用户的明确意图，这里不再弹二次确认框。 */
async function handleStartAllQueryParam() {
  const params = new URLSearchParams(location.search);
  params.delete('action');
  const newSearch = params.toString();
  history.replaceState(null, '', location.pathname + (newSearch ? `?${newSearch}` : '') + location.hash);

  switchToTab('run');
  try {
    const { active } = await fetchJson('/api/runs/active');
    if (active) {
      state.run.viewingRunId = active.runId;
      refreshRunView();
      return;
    }
  } catch {
    // 查询失败也继续尝试启动，服务端会给出明确错误提示。
  }
  await startRun({ mode: 'all' });
}

/** 页面刚加载、没有 ?action=start-all 时：如果已经有活动运行，自动切到实时运行页，不用用户自己找。 */
async function initialRunCheck() {
  try {
    const { active } = await fetchJson('/api/runs/active');
    if (active) {
      state.run.viewingRunId = active.runId;
      switchToTab('run');
    }
  } catch {
    // 拿不到就当没有活动运行，留在默认的总览页。
  }
}

// ---- SSE ----

function connectEvents() {
  const statusEl = document.getElementById('conn-status');
  const source = new EventSource('/api/events');
  let everDisconnected = false;
  source.addEventListener('connected', () => {
    statusEl.textContent = '已连接';
    statusEl.className = 'conn-status connected';
    // SSE 断线重连后，浏览器原生的 EventSource 会自动发起新连接、再收到一次
    // connected 事件；这个窗口里可能错过了若干个运行事件，必须重新拉取一次
    // 权威快照，不能假装什么都没发生过——不重连补一次的话，运行进度/统计
    // 会停在断线前的最后一次画面，直到下一个事件恰好到达才会更新。
    if (everDisconnected) refreshRunView();
  });
  source.addEventListener('heartbeat', () => {
    statusEl.textContent = '已连接';
    statusEl.className = 'conn-status connected';
  });
  RUN_EVENT_NAMES.forEach((name) => {
    source.addEventListener(name, () => refreshRunView());
  });
  source.onerror = () => {
    everDisconnected = true;
    statusEl.textContent = '连接断开，重连中...';
    statusEl.className = 'conn-status disconnected';
  };
}

// ---- 启动 ----

async function init() {
  try {
    const health = await fetchJson('/api/health');
    state.sessionToken = health.sessionToken;
  } catch {
    // health 拿不到 token 时，写操作会在服务端被 CSRF 校验拒绝，前端能看到明确错误提示。
  }
  setupTabs();
  setupSiteListControls();
  setupSiteForm();
  setupRunTabControls();
  loadOverview();
  loadRuns();
  connectEvents();

  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'start-all') {
    await handleStartAllQueryParam();
  } else {
    await initialRunCheck();
  }

  setInterval(() => {
    loadOverview();
    loadRuns();
  }, 30000);
}

init();
