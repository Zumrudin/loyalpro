// ── DASHBOARD PAGE ─────────────────────────────────────────────
// Зависимости: api(), animateCount(), cascadeCards(), notify(), timeSince()

let dashP = 7;
let rCh, bfCh, lvlCh;
let svcData = [];
let svcSortCol = 'cnt';
let svcSortDir = 'desc';
let svcExpanded = false;

function setPeriod(d, el) {
  dashP = d;
  document.querySelectorAll('#page-dashboard .pb-btns .pb-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  loadDashboard();
}

function buildRevChart(data) {
  const ctx = document.getElementById('revChart').getContext('2d');
  if (rCh) rCh.destroy();
  const labels = data.map(d => { const dt = new Date(d.visit_date + 'T00:00:00'); return dt.getDate() + '.' + (dt.getMonth() + 1); });
  rCh = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Выручка ₽', data: data.map(d => parseFloat(d.revenue || 0)), backgroundColor: 'rgba(0,200,150,0.75)', borderRadius: 3 },
        { label: 'Начислено бонусов', data: data.map(d => parseFloat(d.bonuses_accrued || 0)), backgroundColor: 'rgba(59,130,246,0.65)', borderRadius: 3 },
        { label: 'Списано бонусов', data: data.map(d => parseFloat(d.bonuses_redeemed || 0)), backgroundColor: 'rgba(232,84,84,0.55)', borderRadius: 3 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index' },
      plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 10 } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 15, font: { size: 10 } } },
        y: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { callback: v => v >= 1000 ? (v / 1000).toFixed(0) + 'к' : v, font: { size: 10 } }, title: { display: true, text: '₽', font: { size: 10 } } }
      }
    }
  });
}

function buildRecentTx(txns) {
  const el = document.getElementById('recentTx');
  if (!txns?.length) { el.innerHTML = '<div class="empty">Нет транзакций</div>'; return; }
  const ic = { accrual: '💳', birthday: '🎂', referral: '👥', manual: '✏️', redemption: '💸', cancellation: '❌' };
  el.innerHTML = txns.slice(0, 8).map(t => `
    <div class="ai">
      <div class="ai-ic" style="background:${t.amount > 0 ? '#e6f9f3' : '#fce8e8'}">${ic[t.type] || '💰'}</div>
      <div>
        <div style="font-size:12.5px"><strong>${esc(t.client_name || 'Клиент')}</strong> — <strong style="color:${t.amount > 0 ? 'var(--a)' : 'var(--danger)'}">${t.amount > 0 ? '+' : ''}${t.amount}</strong> бонусов</div>
        <div style="font-size:11px;color:var(--t3)">${esc(t.description || '')} · ${new Date(t.created_at).toLocaleDateString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    </div>`).join('');
}

function buildTopSvc(svcs) {
  if (!svcs?.length) {
    document.getElementById('svcBody').innerHTML = '<tr><td colspan="3" class="empty">Нет данных</td></tr>';
    return;
  }
  svcData = svcs.slice();
  svcSortCol = 'cnt';
  svcSortDir = 'desc';
  renderSvcTable();
}

function svcSort(column) {
  const headers = document.querySelectorAll('#page-dashboard table th.th-sort');
  headers.forEach(h => h.classList.remove('asc', 'desc'));

  if (svcSortCol === column) {
    svcSortDir = svcSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    svcSortCol = column;
    svcSortDir = column === 'service_name' ? 'asc' : 'desc';
  }

  const header = document.querySelector(`[data-col="${svcSortCol}"]`);
  if (header) header.classList.add(svcSortDir);

  renderSvcTable();
}

function renderSvcTable() {
  const sorted = svcData.slice().sort((a, b) => {
    let aVal = a[svcSortCol];
    let bVal = b[svcSortCol];

    if (svcSortCol !== 'service_name') {
      aVal = parseFloat(aVal) || 0;
      bVal = parseFloat(bVal) || 0;
    }

    return svcSortDir === 'asc' ?
      (typeof aVal === 'string' ? aVal.localeCompare(bVal) : aVal - bVal) :
      (typeof aVal === 'string' ? bVal.localeCompare(aVal) : bVal - aVal);
  });

  const tbody = document.getElementById('svcBody');
  const displayed = svcExpanded ? sorted : sorted.slice(0, 10);

  tbody.innerHTML = displayed.map(s => `
    <tr>
      <td>${esc(s.service_name || '—')}</td>
      <td><strong>${s.cnt}</strong></td>
      <td>${parseFloat(s.total_amount || 0).toLocaleString('ru')} ₽</td>
    </tr>
  `).join('');

  // Показываем/скрываем кнопку развертывания
  const btn = document.getElementById('svcToggleBtn');
  if (btn) {
    if (sorted.length > 10) {
      btn.style.display = 'block';
      btn.textContent = svcExpanded ? 'Свернуть ▲' : 'Показать все ▼';
    } else {
      btn.style.display = 'none';
    }
  }
}

function toggleSvc() {
  svcExpanded = !svcExpanded;
  renderSvcTable();
}

function buildBfChart(data) {
  const days = {};
  data.forEach(r => { const d = r.day; if (!days[d]) days[d] = { a: 0, r: 0 }; days[d].a += parseFloat(r.accrued || 0); days[d].r += parseFloat(r.redeemed || 0); });
  const keys = Object.keys(days).sort().slice(-30);
  const ctx = document.getElementById('bfChart').getContext('2d');
  if (bfCh) bfCh.destroy();
  bfCh = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: keys.map(d => { const dt = new Date(d); return dt.getDate() + '.' + (dt.getMonth() + 1); }),
      datasets: [
        { label: 'Начислено', data: keys.map(k => days[k].a), backgroundColor: 'rgba(0,200,150,0.6)', borderRadius: 3 },
        { label: 'Списано', data: keys.map(k => days[k].r), backgroundColor: 'rgba(232,84,84,0.5)', borderRadius: 3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 10 } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { size: 10 } } }
      }
    }
  });
}

function buildLvlChart(dist) {
  const ctx = document.getElementById('lvlChart').getContext('2d');
  if (lvlCh) lvlCh.destroy();
  const K = ['platinum', 'gold', 'silver', 'bronze'], C = ['#00c896', '#f59e0b', '#9e9e9e', '#cd7f32'];
  const map = {}; dist.forEach(d => map[d.loyalty_level] = parseInt(d.cnt) || 0);
  lvlCh = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['💎 Платина', '🥇 Золото', '🥈 Серебро', '🥉 Бронза'],
      datasets: [{ data: K.map(k => map[k] || 0), backgroundColor: C, borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 9 } } } }
  });
}

function buildLvlDash(dist, total) {
  const LVL = [{ key: 'platinum', l: '💎 Платина', c: '#6366f1' }, { key: 'gold', l: '🥇 Золото', c: '#eab308' }, { key: 'silver', l: '🥈 Серебро', c: '#94a3b8' }, { key: 'bronze', l: '🥉 Бронза', c: '#c9a96e' }];
  const map = {}; dist.forEach(d => map[d.loyalty_level] = parseInt(d.cnt) || 0);
  document.getElementById('lvlDash').innerHTML = LVL.map(l => {
    const pct = total ? Math.round((map[l.key] || 0) / total * 100) : 0;
    return `
    <div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
        <span style="font-weight:600">${l.l}</span>
        <strong style="color:${l.c}">${map[l.key] || 0} <span style="color:var(--t3);font-weight:400">(${pct}%)</span></strong>
      </div>
      <div class="pb"><div class="pf lvl-bar" data-pct="${pct}" style="width:0%;background:${l.c}"></div></div>
    </div>`;
  }).join('');
  requestAnimationFrame(() => {
    document.querySelectorAll('.lvl-bar').forEach(bar => {
      const pct = bar.dataset.pct;
      setTimeout(() => { bar.style.width = pct + '%'; }, 80);
    });
  });
}

function showDashSkeleton() {
  const ids = ['ds1', 'ds2', 'ds3', 'ds5', 'ds6', 'an1', 'an2', 'an3', 'an4', 'an5'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<span class="sk sk-val"></span>';
  });
  ['ds1s', 'ds2s', 'ds3s', 'ds5s', 'ds6s', 'an1s', 'an2s', 'an3s', 'an4s', 'an5s'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<span class="sk sk-sub"></span>';
  });
}

async function loadDashboard() {
  showDashSkeleton();
  try {
    const [d, bon] = await Promise.all([
      api('GET', '/api/analytics/dashboard?period=' + dashP),
      api('GET', '/api/analytics/bonuses?period=' + dashP)
    ]);
    const s = d.stats;

    animateCount(document.getElementById('ds1'), s.totalClients);
    document.getElementById('ds1s').textContent = '+' + s.newClients + ' новых за период';

    animateCount(document.getElementById('ds2'), s.totalBonusBalance);
    document.getElementById('ds2s').textContent = 'начислено ' + parseFloat(s.periodBonuses || 0).toLocaleString('ru') + ' · списано ' + parseFloat(s.periodRedeemed || 0).toLocaleString('ru');

    const rev = parseFloat(s.periodRevenue || 0);
    animateCount(document.getElementById('ds3'), rev, { suffix: ' ₽' });
    document.getElementById('ds3s').textContent = 'за ' + dashP + ' дней · ' + s.periodRecords + ' визитов';

    animateCount(document.getElementById('ds5'), s.cardClients);
    document.getElementById('ds5s').textContent = s.totalClients ? Math.round(s.cardClients / s.totalClients * 100) + '% от всех клиентов' : '';

    animateCount(document.getElementById('ds6'), s.telegramClients);
    document.getElementById('ds6s').textContent = s.totalClients ? Math.round(s.telegramClients / s.totalClients * 100) + '% от всех клиентов' : '';

    const periodBonuses  = parseFloat(s.periodBonuses  || 0);
    const periodRedeemed = parseFloat(s.periodRedeemed || 0);
    const avgCheck = s.periodRecords > 0 ? Math.round(s.periodRevenue / s.periodRecords) : 0;

    animateCount(document.getElementById('an1'), avgCheck, { suffix: ' ₽' });
    document.getElementById('an1s').textContent = s.periodRecords + ' записей за период';

    animateCount(document.getElementById('an2'), periodBonuses, { suffix: ' ₽' });
    document.getElementById('an2s').textContent = 'за ' + dashP + ' дней';

    animateCount(document.getElementById('an5'), periodRedeemed, { suffix: ' ₽' });
    document.getElementById('an5s').textContent = 'за ' + dashP + ' дней';

    const roi = periodBonuses > 0 ? Math.round(s.periodRevenue / periodBonuses) : 0;
    if (roi > 0) animateCount(document.getElementById('an3'), roi, { suffix: 'x' });
    else document.getElementById('an3').textContent = '—';

    animateCount(document.getElementById('an4'), s.newClients);
    document.getElementById('an4s').textContent = 'за ' + dashP + ' дней';

    buildRevChart(d.dailyRevenue);
    buildLvlDash(d.levelDist, s.totalClients);
    buildRecentTx(d.recentTxns);
    buildTopSvc(d.topServices);
    buildBfChart(bon);
    buildLvlChart(d.levelDist);
    if (d.syncStatus?.finished_at) document.getElementById('syncSt').textContent = 'Синхр.: ' + timeSince(d.syncStatus.finished_at);

    cascadeCards('#page-dashboard .sc', 50);

  } catch (e) { notify('Ошибка дашборда: ' + e.message, 'err'); }
}
