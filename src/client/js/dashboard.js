/**
 * mcp-pulse — Dashboard Frontend JavaScript
 * Real-time WebSocket-powered observability dashboard
 */

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  connected: false,
  calls: [],
  servers: [],
  alerts: [],
  metrics: null,
  timeseries: [],
  currentView: 'overview',
  callsPage: 0,
  callsPageSize: 50,
  filters: { serverId: '', status: '', tool: '' },
  chart: null,
  startTime: Date.now(),
};

const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`;
const API = '/api';

// ─── WebSocket ───────────────────────────────────────────────────────────────
function connectWS() {
  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    setStatus('connected', 'Live');
    loadInitialData();
  };

  ws.onclose = () => {
    state.connected = false;
    setStatus('connecting', 'Reconnecting…');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleEvent(event);
    } catch { /* ignore */ }
  };
}

function handleEvent(event) {
  switch (event.type) {
    case 'call:start':
      break;
    case 'call:end':
    case 'call:error': {
      const call = event.payload;
      state.calls.unshift(call);
      if (state.calls.length > 2000) state.calls.pop();
      updateCallsBadge();
      renderRecentCalls();
      if (state.currentView === 'calls') CallsView.render();
      break;
    }
    case 'metrics:update': {
      state.metrics = event.payload.metrics;
      renderMetrics(state.metrics);
      loadTimeseries();
      break;
    }
    case 'alert:trigger': {
      state.alerts.unshift(event.payload.alert);
      updateAlertsBadge();
      if (state.currentView === 'alerts') AlertsView.render();
      showAlertToast(event.payload.alert);
      break;
    }
    case 'server:connect': {
      const server = event.payload.server;
      const idx = state.servers.findIndex(s => s.id === server.id);
      if (idx >= 0) state.servers[idx] = server;
      else state.servers.push(server);
      updateServersBadge();
      if (state.currentView === 'servers') ServersView.render();
      break;
    }
    case 'server:disconnect': {
      const { serverId } = event.payload;
      const s = state.servers.find(s => s.id === serverId);
      if (s) s.status = 'disconnected';
      if (state.currentView === 'servers') ServersView.render();
      break;
    }
    case 'heartbeat':
      break;
  }
}

// ─── Initial Data Load ───────────────────────────────────────────────────────
async function loadInitialData() {
  const [metricsRes, callsRes, serversRes, alertsRes] = await Promise.all([
    fetch(`${API}/metrics`).then(r => r.json()),
    fetch(`${API}/calls?limit=100`).then(r => r.json()),
    fetch(`${API}/servers`).then(r => r.json()),
    fetch(`${API}/alerts?limit=50`).then(r => r.json()),
  ]);

  if (metricsRes.ok) { state.metrics = metricsRes.data; renderMetrics(state.metrics); }
  if (callsRes.ok) { state.calls = callsRes.data; updateCallsBadge(); renderRecentCalls(); }
  if (serversRes.ok) { state.servers = serversRes.data; updateServersBadge(); }
  if (alertsRes.ok) { state.alerts = alertsRes.data; updateAlertsBadge(); }

  await loadTimeseries();
  renderTopTools();
}

async function loadTimeseries() {
  const res = await fetch(`${API}/metrics/timeseries?window=60`).then(r => r.json());
  if (res.ok) {
    state.timeseries = res.data;
    renderChart();
  }
}

// ─── Metrics Render ──────────────────────────────────────────────────────────
function renderMetrics(m) {
  if (!m) return;
  setText('totalCallsValue', m.totalCalls.toLocaleString());
  setText('callsPerMin', `${m.callsPerMinute}/min`);
  setText('errorRateValue', `${m.errorRate.toFixed(1)}%`);
  setText('totalErrorsValue', `${m.totalErrors} errors`);
  setText('avgLatencyValue', formatMs(m.avgLatency));
  setText('p99Latency', `P99: ${formatMs(m.latencyP99)}`);
  setText('activeServersValue', m.activeServers.toString());

  // Color cues
  const errCard = document.getElementById('metricErrorRate');
  if (errCard) {
    errCard.classList.toggle('bad', m.errorRate > 10);
    errCard.classList.toggle('warn', m.errorRate > 5 && m.errorRate <= 10);
    errCard.classList.toggle('good', m.errorRate === 0);
  }

  renderTopTools(m.topTools);
}

// ─── Top Tools ────────────────────────────────────────────────────────────────
function renderTopTools(tools) {
  const list = tools ?? state.metrics?.topTools ?? [];
  const el = document.getElementById('topToolsList');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = `<div class="tool-list-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#334155" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <p>No calls yet</p>
    </div>`;
    return;
  }

  el.innerHTML = list.slice(0, 10).map((t, i) => `
    <div class="tool-item">
      <span class="tool-rank">${i + 1}</span>
      <div class="tool-info">
        <div class="tool-name">${escHtml(t.tool)}</div>
        <div class="tool-server">${escHtml(t.serverId)}</div>
      </div>
      <div class="tool-stats">
        <div class="tool-stat">
          <span class="tool-stat-value">${t.calls.toLocaleString()}</span>
          <span class="tool-stat-label">calls</span>
        </div>
        <div class="tool-stat">
          <span class="tool-stat-value ${t.errorRate > 5 ? 'tool-error' : 'tool-success'}">${t.errorRate.toFixed(1)}%</span>
          <span class="tool-stat-label">errors</span>
        </div>
        <div class="tool-stat">
          <span class="tool-stat-value">${formatMs(t.avgLatency)}</span>
          <span class="tool-stat-label">avg</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ─── Recent Calls ─────────────────────────────────────────────────────────────
function renderRecentCalls() {
  const el = document.getElementById('recentCalls');
  if (!el) return;
  const recent = state.calls.slice(0, 20);

  if (!recent.length) {
    el.innerHTML = `<div class="recent-calls-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#334155" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <p>Waiting for calls...</p>
    </div>`;
    return;
  }

  el.innerHTML = recent.map(c => `
    <div class="recent-call-item new-call" onclick="Modal.showCall('${c.id}')">
      <span class="call-status-dot ${c.status}"></span>
      <div class="recent-call-info">
        <div class="recent-call-tool">${escHtml(c.tool)}</div>
        <div class="recent-call-server">${escHtml(c.serverName ?? c.serverId)}</div>
      </div>
      <div class="recent-call-meta">
        <span class="recent-call-duration" style="color:${latencyColor(c.duration)}">${formatMs(c.duration)}</span>
        <span class="recent-call-time">${timeAgo(c.timestamp)}</span>
      </div>
    </div>
  `).join('');
}

// ─── Chart ────────────────────────────────────────────────────────────────────
function renderChart() {
  const canvas = document.getElementById('latencyChart');
  if (!canvas) return;

  const ts = state.timeseries;
  if (!ts.length) return;

  const labels = ts.map(p => {
    const d = new Date(p.timestamp);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  });

  const callsData = ts.map(p => p.calls);
  const errorsData = ts.map(p => p.errors);
  const latencyData = ts.map(p => p.latencyAvg);

  // Tiny inline chart renderer (no Chart.js dependency)
  drawLineChart(canvas, { labels, callsData, errorsData, latencyData });
}

function drawLineChart(canvas, { labels, callsData, errorsData, latencyData }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const pad = { top: 12, right: 20, bottom: 28, left: 44 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#1c1c30';
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = pad.top + (cH / gridLines) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
  }

  // Helper: draw line
  const maxCalls = Math.max(...callsData, 1);
  const maxLatency = Math.max(...latencyData, 1);

  function plotLine(data, maxVal, color, filled) {
    if (!data.length) return;
    const pts = data.map((v, i) => ({
      x: pad.left + (i / (data.length - 1)) * cW,
      y: pad.top + cH - (v / maxVal) * cH,
    }));

    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));

    if (filled) {
      ctx.lineTo(pts[pts.length - 1].x, pad.top + cH);
      ctx.lineTo(pts[0].x, pad.top + cH);
      ctx.closePath();
      ctx.fillStyle = color + '14';
      ctx.fill();
    }

    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  plotLine(callsData, maxCalls, '#3b82f6', true);
  plotLine(errorsData, maxCalls, '#ef4444', false);
  plotLine(latencyData, maxLatency, '#a855f7', false);

  // X-axis labels
  ctx.fillStyle = '#4a5068';
  ctx.font = `10px 'JetBrains Mono', monospace`;
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.floor(labels.length / 8));
  labels.forEach((label, i) => {
    if (i % step === 0) {
      ctx.fillText(label, pad.left + (i / (labels.length - 1)) * cW, H - 6);
    }
  });
}

// ─── Views ────────────────────────────────────────────────────────────────────
const App = {
  view(name) {
    state.currentView = name;
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const view = document.getElementById(`view${capitalize(name)}`);
    if (view) view.style.display = '';

    const nav = document.querySelector(`[data-view="${name}"]`);
    if (nav) nav.classList.add('active');

    switch (name) {
      case 'calls': CallsView.render(); break;
      case 'servers': ServersView.render(); break;
      case 'alerts': AlertsView.render(); break;
      case 'overview': renderRecentCalls(); renderTopTools(); renderChart(); break;
    }
  }
};

// ─── Calls View ───────────────────────────────────────────────────────────────
const CallsView = {
  render() {
    const tbody = document.getElementById('callsTableBody');
    if (!tbody) return;

    const filtered = state.calls.filter(c => {
      if (state.filters.serverId && c.serverId !== state.filters.serverId) return false;
      if (state.filters.status && c.status !== state.filters.status) return false;
      if (state.filters.tool && !c.tool.toLowerCase().includes(state.filters.tool.toLowerCase())) return false;
      return true;
    });

    const page = state.callsPage;
    const pageSize = state.callsPageSize;
    const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);

    if (!paginated.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:#4a5068">No calls found</td></tr>`;
      return;
    }

    tbody.innerHTML = paginated.map(c => `
      <tr onclick="Modal.showCall('${c.id}')">
        <td>
          <span class="table-status-badge ${c.status}">${c.status}</span>
        </td>
        <td class="table-time">${formatTime(c.timestamp)}</td>
        <td class="table-server">${escHtml(c.serverName ?? c.serverId)}</td>
        <td class="table-tool">${escHtml(c.tool)}</td>
        <td class="table-duration ${latencyClass(c.duration)}">${formatMs(c.duration)}</td>
        <td class="table-size">${formatBytes(c.size ?? 0)}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();Modal.showCall('${c.id}')">Detail →</button></td>
      </tr>
    `).join('');

    const total = filtered.length;
    setText('paginationInfo', `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} of ${total.toLocaleString()}`);
    document.getElementById('callsPagePrev').disabled = page === 0;
    document.getElementById('callsPageNext').disabled = (page + 1) * pageSize >= total;
  },

  prevPage() {
    if (state.callsPage > 0) { state.callsPage--; this.render(); }
  },
  nextPage() {
    state.callsPage++;
    this.render();
  },
  export() {
    window.location.href = '/api/export?format=csv';
  },
};

// ─── Servers View ─────────────────────────────────────────────────────────────
const ServersView = {
  render() {
    const grid = document.getElementById('serversGrid');
    const subtitle = document.getElementById('serverSubtitle');
    if (!grid) return;

    const active = state.servers.filter(s => s.status === 'connected').length;
    if (subtitle) setText('serverSubtitle', `${active}/${state.servers.length} connected`);

    if (!state.servers.length) {
      grid.innerHTML = `<div style="color:#4a5068;padding:40px;text-align:center">No servers connected</div>`;
      return;
    }

    grid.innerHTML = state.servers.map(s => `
      <div class="server-card">
        <div class="server-card-header">
          <div>
            <div class="server-name">${escHtml(s.name)}</div>
            <div class="server-version">v${escHtml(s.version)} · MCP ${escHtml(s.protocolVersion)}</div>
          </div>
          <span class="server-status-badge ${s.status}">${s.status}</span>
        </div>
        <div style="font-size:0.72rem;color:#4a5068;font-family:var(--font-mono);margin-bottom:8px">
          Connected ${timeAgo(s.connectedAt)} · Last active ${timeAgo(s.lastActivityAt)}
        </div>
        <div class="server-stats">
          <div class="server-stat">
            <div class="server-stat-value">${s.calls.toLocaleString()}</div>
            <div class="server-stat-label">Calls</div>
          </div>
          <div class="server-stat">
            <div class="server-stat-value" style="color:${s.errors > 0 ? 'var(--accent-red)' : 'var(--accent-green)'}">${s.errors.toLocaleString()}</div>
            <div class="server-stat-label">Errors</div>
          </div>
          <div class="server-stat">
            <div class="server-stat-value">${formatMs(s.avgLatency)}</div>
            <div class="server-stat-label">Avg Lat</div>
          </div>
        </div>
        ${s.capabilities ? `
          <div style="margin-top:10px;display:flex;gap:4px;flex-wrap:wrap">
            ${Object.keys(s.capabilities).map(cap => 
              `<span style="background:var(--accent-blue-dim);color:var(--accent-blue);border:1px solid rgba(59,130,246,.2);padding:2px 7px;border-radius:10px;font-size:0.68rem">${cap}</span>`
            ).join('')}
          </div>
        ` : ''}
      </div>
    `).join('');
  }
};

// ─── Alerts View ──────────────────────────────────────────────────────────────
const AlertsView = {
  render() {
    const list = document.getElementById('alertsList');
    if (!list) return;

    if (!state.alerts.length) {
      list.innerHTML = `<div style="text-align:center;padding:60px;color:#4a5068">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#334155" stroke-width="1.5" style="margin:0 auto 12px;display:block"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
        <p>No alerts fired</p>
      </div>`;
      return;
    }

    list.innerHTML = state.alerts.map(a => `
      <div class="alert-item ${a.severity} ${a.resolvedAt ? 'resolved' : ''}">
        <div class="alert-icon ${a.severity}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
        </div>
        <div class="alert-info">
          <div class="alert-name">${escHtml(a.name)}</div>
          <div class="alert-message">${escHtml(a.message)}</div>
          <div class="alert-meta">${formatTime(a.firedAt)} · ${a.metric} = ${a.value.toFixed(2)} (threshold: ${a.threshold})</div>
        </div>
        <div class="alert-actions">
          <span class="table-status-badge ${a.severity}">${a.severity}</span>
        </div>
      </div>
    `).join('');
  },

  showConfig() {
    document.getElementById('alertConfigModal').classList.add('open');
    this.renderConfigs();
  },
  closeConfig() {
    document.getElementById('alertConfigModal').classList.remove('open');
  },
  renderConfigs() {
    const el = document.getElementById('alertConfigsList');
    if (!el) return;
    el.innerHTML = '<p style="color:#4a5068;font-size:.82rem;margin-bottom:12px">Config editor not yet implemented in this preview.</p>';
  },
  addConfig() {},
  saveConfig() { this.closeConfig(); },
};

// ─── Modal ─────────────────────────────────────────────────────────────────────
const Modal = {
  showCall(id) {
    const call = state.calls.find(c => c.id === id);
    if (!call) return;

    setText('modalTitle', `${call.tool} · ${formatMs(call.duration)}`);

    const body = document.getElementById('modalBody');
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
        <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px">
          <div style="font-size:.7rem;color:#4a5068;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Status</div>
          <span class="table-status-badge ${call.status}">${call.status}</span>
        </div>
        <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px">
          <div style="font-size:.7rem;color:#4a5068;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Duration</div>
          <span style="font-family:var(--font-mono);font-weight:700;color:${latencyColor(call.duration)}">${formatMs(call.duration)}</span>
        </div>
        <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px">
          <div style="font-size:.7rem;color:#4a5068;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Server</div>
          <span style="font-family:var(--font-mono);font-size:.82rem">${escHtml(call.serverName ?? call.serverId)}</span>
        </div>
        <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px">
          <div style="font-size:.7rem;color:#4a5068;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Timestamp</div>
          <span style="font-family:var(--font-mono);font-size:.78rem;color:#8b92a8">${formatTime(call.timestamp)}</span>
        </div>
      </div>

      <div style="margin-bottom:12px">
        <div style="font-size:.78rem;font-weight:600;margin-bottom:6px;color:#8b92a8">Request</div>
        <div class="json-viewer">${syntaxHighlight(call.request)}</div>
      </div>

      ${call.response ? `
      <div>
        <div style="font-size:.78rem;font-weight:600;margin-bottom:6px;color:#8b92a8">Response</div>
        <div class="json-viewer">${syntaxHighlight(call.response)}</div>
      </div>` : ''}

      ${call.errorMessage ? `
      <div style="margin-top:12px;background:var(--accent-red-dim);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:12px">
        <div style="font-size:.72rem;color:var(--accent-red);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Error</div>
        <div style="font-family:var(--font-mono);font-size:.78rem;color:var(--accent-red)">${escHtml(call.errorMessage)}</div>
      </div>` : ''}
    `;

    document.getElementById('callDetailModal').classList.add('open');
  },

  close() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
  }
};

// ─── Toast Alerts ─────────────────────────────────────────────────────────────
function showAlertToast(alert) {
  const toast = document.createElement('div');
  const colors = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
  toast.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:2000;
    background:var(--bg-modal);border:1px solid ${colors[alert.severity] ?? '#3b82f6'};
    border-radius:10px;padding:14px 18px;max-width:340px;
    box-shadow:0 8px 32px rgba(0,0,0,.5);
    animation:slideInRight 300ms cubic-bezier(.34,1.56,.64,1);
    font-size:.82rem;
  `;
  toast.innerHTML = `
    <div style="font-weight:600;color:${colors[alert.severity]};margin-bottom:4px">⚠ ${escHtml(alert.name)}</div>
    <div style="color:#8b92a8">${escHtml(alert.message)}</div>
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ─── Uptime Timer ─────────────────────────────────────────────────────────────
setInterval(() => {
  const elapsed = Date.now() - state.startTime;
  const h = Math.floor(elapsed / 3600000).toString().padStart(2,'0');
  const m = Math.floor((elapsed % 3600000) / 60000).toString().padStart(2,'0');
  const s = Math.floor((elapsed % 60000) / 1000).toString().padStart(2,'0');
  setText('uptimeValue', `${h}:${m}:${s}`);
}, 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusText');
  if (dot) dot.className = `status-dot ${type}`;
  if (label) label.textContent = text;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function updateCallsBadge() {
  const badge = document.getElementById('callsBadge');
  if (badge) badge.textContent = state.calls.length.toLocaleString();
}
function updateServersBadge() {
  const badge = document.getElementById('serversBadge');
  if (badge) badge.textContent = state.servers.filter(s => s.status === 'connected').length.toString();
}
function updateAlertsBadge() {
  const badge = document.getElementById('alertsBadge');
  if (badge) badge.textContent = state.alerts.length.toString();
}

function formatMs(ms) {
  if (ms == null || isNaN(ms)) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function latencyColor(ms) {
  if (ms < 200) return 'var(--accent-green)';
  if (ms < 1000) return 'var(--accent-amber)';
  return 'var(--accent-red)';
}

function latencyClass(ms) {
  if (ms < 200) return 'fast';
  if (ms < 1000) return 'medium';
  return 'slow';
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function syntaxHighlight(obj) {
  const json = JSON.stringify(obj, null, 2);
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
      let cls = 'json-number';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'json-key' : 'json-string';
      else if (/true|false/.test(match)) cls = 'json-boolean';
      else if (/null/.test(match)) cls = 'json-null';
      return `<span class="${cls}">${match}</span>`;
    });
}

// ─── Filter Listeners ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => App.view(btn.dataset.view));
  });

  // Filters
  document.getElementById('filterServer')?.addEventListener('change', e => {
    state.filters.serverId = e.target.value;
    state.callsPage = 0;
    CallsView.render();
  });
  document.getElementById('filterStatus')?.addEventListener('change', e => {
    state.filters.status = e.target.value;
    state.callsPage = 0;
    CallsView.render();
  });
  document.getElementById('filterTool')?.addEventListener('input', e => {
    state.filters.tool = e.target.value;
    state.callsPage = 0;
    CallsView.render();
  });

  // Close modals on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) Modal.close();
    });
  });

  // Resize chart on window resize
  window.addEventListener('resize', () => {
    if (state.currentView === 'overview') renderChart();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') Modal.close();
    if (e.key === '1') App.view('overview');
    if (e.key === '2') App.view('calls');
    if (e.key === '3') App.view('servers');
    if (e.key === '4') App.view('alerts');
  });

  connectWS();
});
