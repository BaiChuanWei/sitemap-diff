// Sitemap 监控面板前端。原生 DOM，无框架，无构建步骤。
// 安全原则：所有来自服务端的数据一律用 textContent 赋值，不使用 innerHTML
// 拼接，避免 Sitemap URL / 页面标题 / notes 里可能出现的恶意内容被当作
// HTML 执行。

const STATUS_LABEL = { success: '成功', partial: '部分成功', failed: '失败', running: '进行中' };

const state = {
  sessionToken: null,
  allSites: [],
  page: 1,
  pageSize: 20,
  editingSiteId: null, // null = 新增模式
  formConfigVersion: undefined,
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
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-page').forEach((p) => (p.hidden = true));
      document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
      if (btn.dataset.tab === 'sites') loadSiteManageList();
    });
  });
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const pageItems = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

  tbody.replaceChildren();
  if (pageItems.length === 0) {
    tbody.append(rowWithMessage(11, '没有符合条件的站点'));
  }
  for (const s of pageItems) {
    const tr = el('tr');
    tr.append(
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

// ---- SSE ----

function connectEvents() {
  const statusEl = document.getElementById('conn-status');
  const source = new EventSource('/api/events');
  source.addEventListener('connected', () => {
    statusEl.textContent = '已连接';
    statusEl.className = 'conn-status connected';
  });
  source.addEventListener('heartbeat', () => {
    statusEl.textContent = '已连接';
    statusEl.className = 'conn-status connected';
  });
  source.onerror = () => {
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
  loadOverview();
  loadRuns();
  connectEvents();
  setInterval(() => {
    loadOverview();
    loadRuns();
  }, 30000);
}

init();
