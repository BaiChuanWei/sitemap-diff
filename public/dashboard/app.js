// Sitemap 监控面板前端（M1：只读展示）。原生 DOM，无框架，无构建步骤。
// 安全原则：所有来自服务端的数据一律用 textContent 赋值，不使用 innerHTML
// 拼接，避免 Sitemap URL / 页面标题里可能出现的恶意内容被当作 HTML 执行。

const STATUS_LABEL = { success: '成功', partial: '部分成功', failed: '失败', running: '进行中' };

async function fetchJson(path) {
  const res = await fetch(path, { headers: { host: location.host } });
  if (!res.ok) throw new Error(`请求失败: ${path} (HTTP ${res.status})`);
  return res.json();
}

function el(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusBadge(status) {
  const span = el('span', {
    className: `status-badge status-${status || 'unknown'}`,
    text: STATUS_LABEL[status] || status || '未知',
  });
  return span;
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

async function loadSites() {
  const tbody = document.querySelector('#sites-table tbody');
  try {
    const { sites } = await fetchJson('/api/sites');
    tbody.replaceChildren();
    if (sites.length === 0) {
      tbody.append(rowWithMessage(7, '暂无站点，请检查 config/sites.csv'));
      return;
    }
    for (const s of sites) {
      const tr = el('tr');
      tr.append(
        el('td', { text: s.site_id }),
        el('td', { text: s.domain || '-' }),
        el('td', { text: s.enabled ? '是' : '否' }),
        wrapCell(statusBadge(s.last_status)),
        el('td', { text: formatTime(s.last_success_at) }),
        el('td', { text: s.last_error || '-' }),
        el('td', { text: s.baseline_completed_at ? formatTime(s.baseline_completed_at) : '未建立' }),
      );
      tbody.append(tr);
    }
  } catch (err) {
    tbody.replaceChildren(rowWithMessage(7, `加载失败：${err.message}`));
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
    // EventSource 会自动重连，这里不需要手动重建。
  };
}

function refreshAll() {
  loadOverview();
  loadSites();
  loadRuns();
}

refreshAll();
connectEvents();
setInterval(refreshAll, 30000);
