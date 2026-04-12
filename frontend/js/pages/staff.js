// ── STAFF ANALYTICS PAGE ───────────────────────────────────────
// Зависимости: api(), notify()

let saRadarChart = null, saTrendChart = null;
const saSparkCharts = {};

async function loadStaffAnalytics() {
  saInitDates();
  try {
    const d = await api('GET', '/api/staff-analytics/staff');
    const sel = document.getElementById('sa-staff');
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Сотрудник —</option>' +
      (d.staff || []).map(s => `<option value="${s.id}">${esc(s.name || 'Без имени')}${s.specialization ? ' · ' + esc(s.specialization) : ''}</option>`).join('');
    if (prev) sel.value = prev;
  } catch(e) { /* staff not yet synced */ }
}

function saInitDates() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const f = new Date(y, m, 1), t = new Date(y, m + 1, 0);
  const fi = document.getElementById('sa-from'), ti = document.getElementById('sa-to');
  if (!fi.value) fi.value = f.toISOString().split('T')[0];
  if (!ti.value) ti.value = t.toISOString().split('T')[0];
}

function saOnPeriodChange() {
  const p = document.getElementById('sa-period').value;
  const cd = document.getElementById('sa-custom-dates');
  cd.style.display = p === 'custom' ? 'flex' : 'none';
  if (p === 'custom') return;
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  let f, t;
  if (p === 'month') { f = new Date(y, m, 1); t = new Date(y, m + 1, 0); }
  else { const qs = Math.floor(m / 3) * 3; f = new Date(y, qs, 1); t = new Date(y, qs + 3, 0); }
  document.getElementById('sa-from').value = f.toISOString().split('T')[0];
  document.getElementById('sa-to').value   = t.toISOString().split('T')[0];
}

async function buildStaffDashboard() {
  const staffId = document.getElementById('sa-staff').value;
  const from    = document.getElementById('sa-from').value;
  const to      = document.getElementById('sa-to').value;
  if (!staffId) { notify('Выберите сотрудника', 'err'); return; }
  if (!from || !to) { notify('Укажите период', 'err'); return; }

  document.getElementById('sa-empty').style.display = 'none';
  document.getElementById('sa-content').style.display = 'block';
  ['check','ret','reapp','goods','util','total','cancelled','revenue'].forEach(k => {
    const el = document.getElementById('sa-v-' + k);
    if (el) el.textContent = '...';
  });

  try {
    const [mr, ar] = await Promise.all([
      api('GET', `/api/staff-analytics/metrics?staffId=${staffId}&from=${from}&to=${to}`),
      api('GET', `/api/staff-analytics/salon-avg?from=${from}&to=${to}&excludeStaffId=${staffId}`).catch(() => ({avg: null}))
    ]);
    const {metrics, sparklines, prevMetrics} = mr;

    document.getElementById('sa-v-total').textContent     = (metrics.totalVisits || 0).toLocaleString('ru');
    document.getElementById('sa-v-cancelled').textContent = (metrics.cancelledCount || 0).toLocaleString('ru');
    document.getElementById('sa-v-revenue').textContent   = (metrics.totalRevenue || 0).toLocaleString('ru', {maximumFractionDigits: 0}) + ' ₽';

    saRenderCard('check', saFmt(metrics.avgCheck, '₽'), metrics.avgCheck, prevMetrics.avgCheck);
    const retValStr = metrics.retentionRate !== null ? saFmt(metrics.retentionRate, '%') : '—';
    saRenderCard('ret', retValStr, metrics.retentionRate, prevMetrics.retentionRate);
    const retDetailEl = document.getElementById('sa-ret-detail');
    if (retDetailEl) {
      if (metrics.base45days > 0) {
        retDetailEl.textContent = `${metrics.returnedFrom45} из ${metrics.base45days} за 45 дн. до периода · ${metrics.newClients} новых · ${metrics.returningClients} вернувшихся`;
      } else {
        retDetailEl.textContent = metrics.clientsTotal > 0 ? `${metrics.newClients} новых · ${metrics.returningClients} вернувшихся` : '';
      }
    }
    saRenderCard('reapp', saFmt(metrics.reappointmentRate, '%'), metrics.reappointmentRate, prevMetrics.reappointmentRate);
    const goodsVal = metrics.goodsRevenue > 0 ? metrics.goodsRevenue.toLocaleString('ru') + ' ₽' : 'Нет данных';
    saRenderCard('goods', goodsVal, metrics.goodsRevenue, prevMetrics?.goodsRevenue);
    const goodsDetailEl = document.getElementById('sa-goods-detail');
    if (goodsDetailEl) goodsDetailEl.textContent = metrics.goodsCount > 0 ? `${metrics.goodsCount} позиций` : '';

    saRenderCard('util', metrics.utilizationRate !== null ? saFmt(metrics.utilizationRate, '%') : '—', metrics.utilizationRate, prevMetrics.utilizationRate);
    const utilDetailEl = document.getElementById('sa-util-detail');
    if (utilDetailEl) {
      if (metrics.workingDays > 0) {
        const hrs = Math.round(metrics.bookedMins / 60 * 10) / 10;
        utilDetailEl.textContent = `${hrs} ч из ${metrics.workingDays * 8} ч · ${metrics.workingDays} раб. дн.`;
      } else {
        utilDetailEl.textContent = '';
      }
    }

    saRenderSparklines(sparklines);
    saRenderRadar(metrics, ar.avg);
    saRenderTrend(sparklines);
    saRenderInsights(metrics);
  } catch(e) { notify('Ошибка: ' + e.message, 'err'); }
}

function saFmt(val, sfx) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val); if (isNaN(n)) return '—';
  if (sfx === '₽') return n.toLocaleString('ru', {maximumFractionDigits: 0}) + ' ₽';
  return n.toFixed(1).replace(/\.0$/, '') + sfx;
}

function saRenderCard(key, valStr, cur, prev) {
  document.getElementById('sa-v-' + key).textContent = valStr;
  const b = document.getElementById('sa-b-' + key); if (!b) return;
  if (prev !== null && prev !== undefined && cur !== null && cur !== undefined && parseFloat(prev) > 0) {
    const diff = parseFloat(cur) - parseFloat(prev);
    const pct  = (diff / parseFloat(prev) * 100).toFixed(1);
    b.textContent = (diff >= 0 ? '+' : '') + pct + '%';
    b.className   = 'sa-badge ' + (diff >= 0 ? 'sa-badge-up' : 'sa-badge-dn');
  } else { b.textContent = ''; b.className = 'sa-badge'; }
}

const saColors = {check:'#00c896', ret:'#3b82f6', reapp:'#8b5cf6', goods:'#f59e0b', util:'#06b6d4'};
function saHex(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

function saRenderSparklines(sp) {
  const keys = ['check','ret','reapp','goods','util'];
  const dataMap = {
    check: sp.map(r => parseFloat(r.avg_check) || 0),
    ret:   sp.map(() => null), reapp: sp.map(() => null),
    goods: sp.map(() => null), util:  sp.map(() => null),
  };
  keys.forEach(key => {
    const canvas = document.getElementById('sa-spark-' + key); if (!canvas) return;
    if (saSparkCharts[key]) saSparkCharts[key].destroy();
    const data  = dataMap[key].some(v => v !== null) ? dataMap[key] : sp.map(r => parseInt(r.visits) || 0);
    const color = saColors[key];
    saSparkCharts[key] = new Chart(canvas, {
      type: 'line',
      data: {labels: sp.map(r => r.month), datasets: [{data, borderColor: color, borderWidth: 1.5,
        pointRadius: 0, fill: true, backgroundColor: `rgba(${saHex(color)},0.12)`, tension: 0.4}]},
      options: {responsive: false, maintainAspectRatio: false,
        plugins: {legend: {display: false}, tooltip: {enabled: false}},
        scales: {x: {display: false}, y: {display: false}}, animation: false}
    });
  });
}

function saRenderRadar(m, avg) {
  const canvas = document.getElementById('sa-radar');
  if (saRadarChart) { saRadarChart.destroy(); saRadarChart = null; }
  const labels = ['Выручка\n(ср.чек)','Возвращаемость','Продажи\nтоваров','Перезапись','Загрузка'];

  const staffGoodsPerItem = m.goodsCount > 0 ? m.goodsRevenue / m.goodsCount : 0;
  const avgGoodsPerItem   = avg ? (avg.goodsAvgPerItem || 0) : 0;

  const normMoney = (staffVal, avgVal) => {
    const mx = Math.max(staffVal || 0, avgVal || 0, 1);
    return [Math.round((staffVal || 0) / mx * 100), Math.round((avgVal || 0) / mx * 100)];
  };

  const [revS, revA]     = avg ? normMoney(m.avgCheck, avg.avgCheck)           : [Math.min(100, Math.round(m.avgCheck / 5000 * 100)), null];
  const [goodsS, goodsA] = avg ? normMoney(staffGoodsPerItem, avgGoodsPerItem) : [Math.min(100, Math.round(staffGoodsPerItem / 3000 * 100)), null];

  const retS   = Math.round(m.retentionRate     ?? 0);
  const reappS = Math.round(m.reappointmentRate ?? 0);
  const utilS  = Math.round(m.utilizationRate   ?? 0);
  const retA   = avg ? Math.round(avg.retentionRate     ?? 0) : null;
  const reappA = avg ? Math.round(avg.reappointmentRate ?? 0) : null;
  const utilA  = avg ? Math.round(avg.utilizationRate   ?? 0) : null;

  const datasets = [{label: 'Сотрудник', data: [revS, retS, goodsS, reappS, utilS],
    backgroundColor: 'rgba(0,200,150,0.2)', borderColor: 'rgba(0,200,150,0.85)',
    borderWidth: 2, pointBackgroundColor: '#00c896', pointRadius: 4}];
  if (avg) {
    datasets.push({label: 'Ср. по клинике', data: [revA, retA, goodsA, reappA, utilA],
      backgroundColor: 'rgba(59,130,246,0.12)', borderColor: 'rgba(59,130,246,0.6)',
      borderWidth: 2, pointBackgroundColor: '#3b82f6', pointRadius: 3, borderDash: [4, 4]});
    document.getElementById('sa-avg-legend').style.display = '';
  } else { document.getElementById('sa-avg-legend').style.display = 'none'; }

  saRadarChart = new Chart(canvas, {type: 'radar', data: {labels, datasets},
    options: {responsive: true, maintainAspectRatio: false,
      plugins: {legend: {display: false}},
      scales: {r: {min: 0, max: 100, ticks: {stepSize: 25, font: {size: 10}, color: '#8b949e'},
        grid: {color: 'rgba(0,0,0,0.06)'}, angleLines: {color: 'rgba(0,0,0,0.06)'},
        pointLabels: {font: {size: 11}, color: '#57606a'}}}}});
}

function saRenderTrend(sp) {
  const canvas = document.getElementById('sa-trend');
  if (saTrendChart) { saTrendChart.destroy(); saTrendChart = null; }
  if (!sp.length) return;
  const mNames = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  const labels = sp.map(r => { const [, mn] = r.month.split('-'); return mNames[parseInt(mn) - 1]; });
  saTrendChart = new Chart(canvas, {type: 'bar',
    data: {labels, datasets: [
      {label: 'Выручка', data: sp.map(r => parseFloat(r.revenue) || 0),
        backgroundColor: 'rgba(0,200,150,0.7)', borderRadius: 4, yAxisID: 'y'},
      {label: 'Визиты', data: sp.map(r => parseInt(r.visits) || 0), type: 'line',
        borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 2,
        pointRadius: 4, tension: 0.3, yAxisID: 'y1'}
    ]},
    options: {responsive: true, maintainAspectRatio: false,
      plugins: {legend: {display: true, position: 'top', labels: {font: {size: 11}, boxWidth: 12}}},
      scales: {
        y:  {type: 'linear', position: 'left',  grid: {color: 'rgba(0,0,0,0.04)'}, ticks: {font: {size: 10}}},
        y1: {type: 'linear', position: 'right', grid: {display: false},             ticks: {font: {size: 10}}}
      }}});
}

function saRenderInsights(m) {
  const el = document.getElementById('sa-insights');
  const items = [];
  if (m.cancelledCount > 0)
    items.push({icon:'❌', type:'danger',
      title: `Отменённые и незавершённые визиты: ${m.cancelledCount}`,
      body: `Потерянная выручка: <strong>${(m.cancelledRevenue || 0).toLocaleString('ru')} ₽</strong>. Рекомендуем внедрить систему напоминаний за 24ч до визита.`});
  if (m.reappointmentRate < 30 && m.totalVisits >= 5)
    items.push({icon:'📅', type:'warn',
      title: `Низкая перезапись: ${m.reappointmentRate}%`,
      body: `Только ${m.reappointmentRate}% клиентов записываются повторно в течение 24ч после визита. Требуется обучение технике записи у стойки.`});
  if (m.goodsCount === 0 && m.totalVisits >= 5)
    items.push({icon:'🛍️', type:'warn',
      title: 'Нет продаж косметики за период',
      body: 'За выбранный период не зафиксировано ни одной продажи товаров. Обратите внимание на работу с рекомендацией домашнего ухода.'});
  else if (m.goodsCount > 0 && m.goodsRevenue > 0 && m.totalVisits >= 5 && m.goodsRevenue / m.totalVisits < 3000)
    items.push({icon:'🛍️', type:'warn',
      title: `Низкие продажи товаров: ${m.goodsRevenue.toLocaleString('ru')} ₽`,
      body: `${m.goodsCount} позиций за период — в среднем менее 3 000 ₽ на визит. Рекомендуем усилить работу с рекомендацией домашнего ухода.`});
  if (m.retentionRate !== null && m.retentionRate < 40 && m.base45days >= 5)
    items.push({icon:'🔄', type:'warn',
      title: `Возвращаемость ниже нормы: ${m.retentionRate}%`,
      body: `Из ${m.base45days} клиентов за 45 дней до периода вернулись только ${m.returnedFrom45}. Рекомендуется персональная работа с базой.`});
  if (m.retentionRate !== null && m.retentionRate >= 60)
    items.push({icon:'⭐', type:'ok',
      title: `Высокая возвращаемость: ${m.retentionRate}%`,
      body: `${m.returnedFrom45} из ${m.base45days} клиентов вернулись — отличный показатель удержания по методике YClients.`});
  if (m.reappointmentRate >= 50)
    items.push({icon:'✅', type:'ok',
      title: `Хорошая перезапись: ${m.reappointmentRate}%`,
      body: 'Сотрудник эффективно предлагает следующий визит во время приёма.'});
  if (!items.length)
    items.push({icon:'📈', type:'ok', title: 'Показатели в норме', body: 'Продолжайте мониторинг для выявления точек роста.'});
  el.innerHTML = items.map(i => `
    <div class="sa-insight sa-insight-${i.type}">
      <div class="sa-insight-icon">${i.icon}</div>
      <div><div class="sa-insight-title">${i.title}</div><div class="sa-insight-body">${i.body}</div></div>
    </div>`).join('');
}

async function saSyncStaff() {
  const btn = document.getElementById('sa-sync-btn');
  btn.disabled = true;
  try {
    await api('POST', '/api/staff-analytics/sync');
    notify('Синхронизация запущена. Список сотрудников обновится через ~30 сек', 'ok');
    setTimeout(loadStaffAnalytics, 15000);
  } catch(e) { notify('Ошибка: ' + e.message, 'err'); }
  finally { btn.disabled = false; }
}

async function saExportPDF() {
  const btn = document.getElementById('sa-pdf-btn');
  if (!window.html2pdf) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  const sel  = document.getElementById('sa-staff');
  const name = (sel.options[sel.selectedIndex]?.text || 'staff').replace(/[^a-zA-Zа-яА-Я0-9]/g, '_');
  const from = document.getElementById('sa-from').value;
  const to   = document.getElementById('sa-to').value;
  btn.disabled = true; btn.textContent = '...';
  try {
    await html2pdf().set({
      margin: 10, filename: `analytics_${name}_${from}_${to}.pdf`,
      image: {type: 'jpeg', quality: 0.95},
      html2canvas: {scale: 2, useCORS: true},
      jsPDF: {unit: 'mm', format: 'a4', orientation: 'portrait'}
    }).from(document.getElementById('sa-content')).save();
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>PDF';
  }
}
