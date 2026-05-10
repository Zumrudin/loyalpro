// Зависимости: api(), notify(), classifyFeedItem(), greetByHour(), sparklinePath(), heroSubtitle()
// (timeSince used if present in core/utils.js; tolerate absence with simple fallback)

let _dashPeriod = 7;

async function loadDashboard() {
  try {
    const today = new Date();
    const ymd = today.toISOString().slice(0, 10);
    const [dash, segs, todayRecs] = await Promise.all([
      api('GET', `/api/analytics/dashboard?period=${_dashPeriod}`),
      api('GET', '/api/segments').catch(() => null),
      api('GET', `/api/records?dateFrom=${ymd}&dateTo=${ymd}&limit=10`).catch(() => null),
    ]);
    renderDashHero(dash);
    renderDashMetrics(dash);
    renderCashFlowChart(dash);
    renderTopServices(dash);
    renderSegments(segs);
    renderUpcoming(todayRecs);
    renderFeed(dash);
  } catch (e) {
    if (typeof notify === 'function') notify('Не удалось загрузить дашборд: ' + (e.message || e), 'err');
    console.error('loadDashboard:', e);
  }
}

function renderDashHero(dash) {
  const greet = document.getElementById('heroGreet');
  if (greet) {
    const meName = (typeof ME !== 'undefined' && ME && ME.name) ? `, ${ME.name.split(' ')[0]}` : '';
    greet.textContent = greetByHour(new Date().getHours()) + meName;
  }
  const sub = document.getElementById('heroSub');
  const daily = (dash && dash.dailyRevenue) || [];
  let pct = 0;
  if (daily.length >= 4) {
    const half = Math.floor(daily.length / 2);
    const a = daily.slice(0, half).reduce((s, r) => s + parseFloat(r.revenue || 0), 0);
    const b = daily.slice(-half).reduce((s, r) => s + parseFloat(r.revenue || 0), 0);
    if (a > 0) pct = ((b - a) / a) * 100;
  }
  if (sub) sub.textContent = heroSubtitle({
    visits: dash.stats?.periodRecords || 0,
    newCardClients: dash.stats?.newClients || 0,
    revenueDeltaPct: pct,
  });
}

function renderDashMetrics(dash) {
  const s = dash.stats || {};
  const daily = dash.dailyRevenue || [];

  setText('mtRevenue', fmtMoney(s.periodRevenue));
  setSpark('mtRevenueSpark', daily.map(r => parseFloat(r.revenue || 0)));
  setDelta('mtRevenueDelta', computeHalfDelta(daily, 'revenue'));

  setText('mtVisits', String(s.periodRecords || 0));
  setSpark('mtVisitsSpark', daily.map(r => parseInt(r.records || 0)));
  setDelta('mtVisitsDelta', computeHalfDelta(daily, 'records'));

  const avg = (s.periodRecords > 0) ? Math.round(s.periodRevenue / s.periodRecords) : 0;
  setText('mtAvg', fmtMoney(avg));
  setSpark('mtAvgSpark', daily.map(r => {
    const rev = parseFloat(r.revenue || 0), rec = parseInt(r.records || 0);
    return rec > 0 ? rev / rec : 0;
  }));
  setDelta('mtAvgDelta', computeHalfDelta(daily.map(r => {
    const rev = parseFloat(r.revenue || 0), rec = parseInt(r.records || 0);
    return { _avg: rec > 0 ? rev / rec : 0 };
  }), '_avg'));

  setText('mtBonuses', String(Math.round(s.periodBonuses || 0)));
  setSpark('mtBonusesSpark', daily.map(r => parseFloat(r.bonuses_accrued || 0)));
  const noteEl = document.getElementById('mtBonusesNote');
  if (noteEl) noteEl.textContent = `списано ${Math.round(s.periodRedeemed || 0)} ₽`;
  setDelta('mtBonusesDelta', computeHalfDelta(daily, 'bonuses_accrued'));
}

function computeHalfDelta(daily, key) {
  if (!daily || daily.length < 4) return 0;
  const half = Math.floor(daily.length / 2);
  const a = daily.slice(0, half).reduce((s, r) => s + parseFloat(r[key] || 0), 0);
  const b = daily.slice(-half).reduce((s, r) => s + parseFloat(r[key] || 0), 0);
  if (a === 0) return b > 0 ? 100 : 0;
  return ((b - a) / a) * 100;
}

function renderCashFlowChart(dash) {
  const wrap = document.getElementById('cashFlowChart');
  if (!wrap) return;
  const daily = dash.dailyRevenue || [];
  if (!daily.length) { wrap.innerHTML = '<div style="padding:40px;color:var(--ink-3);text-align:center">нет данных за период</div>'; return; }

  const W = 600, H = 240, P = 30;
  const xs = daily.map((_, i) => P + (W - 2 * P) * (daily.length === 1 ? 0 : i / (daily.length - 1)));
  const maxV = Math.max(1, ...daily.map(r => Math.max(parseFloat(r.revenue || 0), parseFloat(r.bonuses_accrued || 0), parseFloat(r.bonuses_redeemed || 0))));
  const yOf = v => P + (H - 2 * P) * (1 - v / maxV);

  const lineRev = daily.map((r, i) => `${i === 0 ? 'M' : 'L'}${xs[i]} ${yOf(parseFloat(r.revenue || 0))}`).join(' ');
  const fillRev = lineRev + ` L${xs[xs.length - 1]} ${H - P} L${xs[0]} ${H - P} Z`;
  const lineAcc = daily.map((r, i) => `${i === 0 ? 'M' : 'L'}${xs[i]} ${yOf(parseFloat(r.bonuses_accrued || 0))}`).join(' ');
  const lineRed = daily.map((r, i) => `${i === 0 ? 'M' : 'L'}${xs[i]} ${yOf(parseFloat(r.bonuses_redeemed || 0))}`).join(' ');

  const grid = [P, P + (H - 2 * P) / 3, P + 2 * (H - 2 * P) / 3, H - P]
    .map(y => `<line class="grid-line" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`).join('');
  const labels = daily.length <= 14
    ? daily.map((r, i) => `<text class="axis-text" x="${xs[i] - 8}" y="${H - 8}">${escapeHtml((r.visit_date || '').slice(8))}</text>`).join('')
    : '';

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="rev-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1b2710" stop-opacity=".12"/>
          <stop offset="1" stop-color="#1b2710" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${fillRev}" fill="url(#rev-grad)"/>
      <path d="${lineRev}" stroke="#1b2710" stroke-width="1.6" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${lineAcc}" stroke="#6b8c3a" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${lineRed}" stroke="#b89868" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="2 4"/>
      ${labels}
    </svg>`;
}

function renderTopServices(dash) {
  const list = document.getElementById('topServicesList');
  if (!list) return;
  const top = (dash.topServices || [])
    .map(s => ({ name: s.service_name, cnt: parseInt(s.cnt), total: parseFloat(s.total_amount || 0) }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 5);
  if (!top.length) { list.innerHTML = '<div style="padding:14px;color:var(--ink-3)">нет данных</div>'; return; }
  const maxCnt = top[0].cnt || 1;
  list.innerHTML = top.map(s => `
    <div class="svc-row">
      <div>
        <div class="svc-name">${escapeHtml(s.name)}</div>
        <div class="svc-meta">${s.cnt > 0 ? Math.round(s.total / s.cnt) + ' ₽ ср.' : ''}</div>
        <div class="svc-bar"><i style="width:${Math.round(s.cnt / maxCnt * 100)}%"></i></div>
      </div>
      <div class="svc-num">${fmtMoney(s.total)}</div>
      <div class="svc-cnt">${s.cnt}×</div>
    </div>
  `).join('');
}

function renderSegments(segs) {
  const widget = document.getElementById('segmentsWidget');
  const sub = document.getElementById('segCardSub');
  if (!widget) return;
  if (!segs || !segs.segments) { widget.innerHTML = '<div style="color:var(--ink-3)">сегменты недоступны</div>'; return; }

  const colors = ['#1b2710', '#6b8c3a', '#cdd9c4', '#b89868', 'rgba(27,39,16,.18)'];
  const total = (segs.segments || []).reduce((s, x) => s + (parseInt(x.client_count) || 0), 0);
  if (sub) sub.textContent = `активная база · ${total} клиентов`;

  const top5 = (segs.segments || []).slice(0, 5);
  const C = 50, R = 38, CIRC = 2 * Math.PI * R;
  let off = 0;
  const slices = top5.map((s, i) => {
    const cnt = parseInt(s.client_count) || 0;
    const len = total > 0 ? (cnt / total) * CIRC : 0;
    const seg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${colors[i] || colors[4]}" stroke-width="10" stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" stroke-linecap="butt"/>`;
    off += len;
    return seg;
  }).join('');

  widget.innerHTML = `
    <div class="donut">
      <svg viewBox="0 0 100 100">
        <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="rgba(27,39,16,.06)" stroke-width="10"/>
        ${slices}
      </svg>
      <div class="donut-center"><div><b>${total}</b><span>всего</span></div></div>
    </div>
    <div class="seg-list">
      ${top5.map((s, i) => `
        <div class="seg-row">
          <span class="seg-dot" style="background:${colors[i] || colors[4]}"></span>
          <span class="seg-name">${escapeHtml(s.label || s.segment_key)}</span>
          <span class="seg-val">${s.client_count || 0}</span>
        </div>
      `).join('')}
    </div>`;
}

function renderUpcoming(todayRecs) {
  const list = document.getElementById('upcomingList');
  if (!list) return;
  if (!todayRecs || !todayRecs.records || !todayRecs.records.length) {
    list.innerHTML = '<div style="padding:14px;color:var(--ink-3)">сегодня записей нет</div>';
    return;
  }
  const now = new Date();
  const records = (todayRecs.records || [])
    .map(r => ({ ...r, _t: new Date(r.visit_datetime || r.visit_date || 0) }))
    .sort((a, b) => a._t - b._t)
    .slice(0, 5);

  list.innerHTML = records.map(r => {
    const isNow = Math.abs(r._t - now) < 30 * 60 * 1000;
    const hh = String(r._t.getHours()).padStart(2, '0');
    const mm = String(r._t.getMinutes()).padStart(2, '0');
    const tag = isNow ? '<div class="time-tag now">сейчас</div>' : `<div class="time-tag">${hh}:${mm}</div>`;
    let services = '';
    if (Array.isArray(r.services)) {
      services = r.services.map(s => s.title || s.name).filter(Boolean).join(', ');
    } else if (typeof r.services === 'string') {
      services = r.services;
    }
    return `
      <div class="upcoming-row">
        ${tag}
        <div>
          <div class="upcoming-name">${escapeHtml(r.client_name || 'Клиент')}</div>
          <div class="upcoming-svc">${escapeHtml(services || '—')}</div>
        </div>
        <div class="upcoming-spec">${escapeHtml(r.staff_name || '—')}</div>
      </div>`;
  }).join('');
}

function renderFeed(dash) {
  const list = document.getElementById('feedList');
  if (!list) return;
  const rows = (dash.recentTxns || []).slice(0, 6);
  if (!rows.length) { list.innerHTML = '<div style="padding:14px;color:var(--ink-3)">нет операций</div>'; return; }

  list.innerHTML = rows.map(t => {
    const { type, cls } = classifyFeedItem({ amount: parseFloat(t.amount), description: t.description });
    const arrow = cls === 'up' ? '↗' : cls === 'dn' ? '↙' : '◆';
    const amt = parseFloat(t.amount);
    const sign = amt > 0 ? '+' : '−';
    const ago = t.created_at ? agoText(new Date(t.created_at)) : '';
    return `
      <div class="fi">
        <div class="fi-ic ${cls}">${arrow}</div>
        <div>
          <div class="fi-text"><strong>${escapeHtml(t.client_name || '?')}</strong> — ${escapeHtml(t.description || type)}</div>
          <div class="fi-meta">${ago}</div>
        </div>
        <div class="fi-amt ${cls}">${sign}${Math.round(Math.abs(amt))}</div>
      </div>`;
  }).join('');
}

// ── helpers ──
function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
function setSpark(id, vals) { const el = document.getElementById(id); if (el) el.setAttribute('d', sparklinePath(vals, 88, 30)); }
function setDelta(id, pct) {
  const el = document.getElementById(id); if (!el) return;
  if (Math.abs(pct) < 0.5) { el.textContent = ''; el.className = 'delta'; return; }
  const up = pct > 0;
  el.textContent = (up ? '▲' : '▼') + ' ' + Math.abs(Math.round(pct * 10) / 10) + ' %';
  el.className = 'delta ' + (up ? 'up' : 'dn');
}
function fmtMoney(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  if (n >= 1000) return Math.round(n).toLocaleString('ru-RU') + ' ₽';
  return Math.round(n) + ' ₽';
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function agoText(d) {
  if (typeof timeSince === 'function') {
    try { return timeSince(d); } catch (e) {}
  }
  const sec = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return sec + ' сек назад';
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' мин назад';
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + ' ч назад';
  return Math.round(hr / 24) + ' дн назад';
}

// Period switcher binding
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#dashPeriod button');
  if (!btn) return;
  document.querySelectorAll('#dashPeriod button').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  _dashPeriod = parseInt(btn.dataset.d) || 7;
  loadDashboard();
});
