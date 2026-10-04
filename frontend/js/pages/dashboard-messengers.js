// ── ДАШБОРД: блок «Переписки в мессенджерах» ─────────────────────────────
// Спека: docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md
// Данные — GET /api/analytics/messengers?from&to (та же пара дат, что у
// остального дашборда). Проценты считает фронт, бэкенд отдаёт только счётчики.
// Файл подключён обычным <script> и делит глобальную область с dashboard.js:
// никаких верхнеуровневых имён, уже занятых там (rCh, bfCh, lvlCh, dashRange…).
// Зависимости из core: api(), esc(), animateCount(); Chart из vendor.

const MSG_CHANNEL_BADGE = {
  tdlib:    { short: 'TG', cls: 'ch-tg' },
  whatsapp: { short: 'WA', cls: 'ch-wa' },
  max:      { short: 'M',  cls: 'ch-max' },
};

function msgPct(part, whole) {
  const p = Number(part) || 0, w = Number(whole) || 0;
  return w > 0 ? Math.round(p / w * 100) + '%' : '—';
}

function msgConvPct(part, whole) {
  const p = Number(part) || 0, w = Number(whole) || 0;
  return w > 0 ? Math.round(p / w * 100) : 0;
}

function msgBadge(channel) {
  // hasOwnProperty.call, а не Object.hasOwn: его нет в Safari < 15.4 / Chrome < 93,
  // а SPA открывают с телефонов. Собственное свойство, а не `in` — иначе канал
  // «constructor» получил бы бейдж из прототипа.
  if (Object.prototype.hasOwnProperty.call(MSG_CHANNEL_BADGE, channel)) return MSG_CHANNEL_BADGE[channel];
  return { short: String(channel || '?').slice(0, 2).toUpperCase(), cls: 'ch-all' };
}

function msgRow(label, badge, s, isTotal) {
  return {
    label, short: badge.short, cls: badge.cls,
    dialogs: Number(s.dialogs) || 0,
    clientFirst: Number(s.clientFirst) || 0,
    bookedSameDay: Number(s.bookedSameDay) || 0,
    conv: msgPct(s.bookedSameDay, s.clientFirst),
    convPct: msgConvPct(s.bookedSameDay, s.clientFirst),
    isTotal,
  };
}

function msgChannelRows(byChannel, totals) {
  const rows = (byChannel || []).map(c => msgRow(c.label || c.channel, msgBadge(c.channel), c, false));
  rows.push(msgRow('Все каналы', { short: 'Σ', cls: 'ch-all' }, totals || {}, true));
  return rows;
}

function msgChartSeries(daily) {
  const labels = [], first = [], booked = [];
  for (const d of daily || []) {
    const [, m, day] = String(d.date).slice(0, 10).split('-');
    labels.push(parseInt(day, 10) + '.' + parseInt(m, 10));
    first.push(Number(d.clientFirst) || 0);
    booked.push(Number(d.bookedSameDay) || 0);
  }
  return { labels, first, booked };
}

function msgTileTexts(t) {
  const s = t || {};
  const noPhone = Number(s.clientFirstNoPhone) || 0;
  const byAgent = Number(s.bookedByAgent) || 0;
  return {
    firstShare: s.dialogs > 0 ? msgPct(s.clientFirst, s.dialogs) + ' диалогов' : '',
    firstSub: noPhone > 0 ? noPhone + ' из них без номера телефона' : 'все с номером телефона',
    bookedPct: s.clientFirst > 0 ? msgPct(s.bookedSameDay, s.clientFirst) : '',
    bookedSub: 'из написавших первыми' + (byAgent > 0 ? ' · ' + byAgent + ' оформила Мила' : ''),
  };
}

// ── DOM-часть (в node --test не вызывается) ──────────────────────────────
let msgCh; // экземпляр Chart, как rCh/bfCh/lvlCh в dashboard.js

function msgSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function msgSetSub(id, dotColor, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (dotColor ? '<span class="dot" style="background:' + dotColor + '"></span>' : '') + esc(text);
}

function renderMessengerTable(rows) {
  const tbody = document.getElementById('msgTbody');
  if (!tbody) return;
  const dataRows = rows.filter(r => !r.isTotal);
  if (!dataRows.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">Нет данных</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `
    <tr${r.isTotal ? ' class="total"' : ''}>
      <td><span class="ch ${esc(r.cls)}"><i>${esc(r.short)}</i>${esc(r.label)}</span></td>
      <td>${r.dialogs}</td>
      <td>${r.clientFirst}</td>
      <td>${r.bookedSameDay}</td>
      <td><span class="conv"><span class="pb"><span class="pf" style="width:${r.convPct}%"></span></span><b>${esc(r.conv)}</b></span></td>
    </tr>`).join('');
}

function renderMessengerChart(daily) {
  const canvas = document.getElementById('msgChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const s = msgChartSeries(daily);
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  // Палитра проверена валидатором dataviz в обеих темах: в тёмной зелёный темнее.
  const GREEN = dark ? '#00a87c' : '#00c896', BLUE = '#3b82f6';
  const ink = dark ? '#8b949e' : '#57606a';
  if (msgCh) msgCh.destroy();
  msgCh = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: s.labels, datasets: [
      { label: 'Написали первыми', data: s.first, backgroundColor: BLUE, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', barPercentage: 0.85, categoryPercentage: 0.8 },
      { label: 'Записались в тот же день', data: s.booked, backgroundColor: GREEN, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', barPercentage: 0.85, categoryPercentage: 0.8 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { footer: items => {
        const f = items[0]?.raw || 0, b = items[1]?.raw || 0;
        return f ? 'Конверсия ' + Math.round(b / f * 100) + '%' : '';
      } } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 15, font: { size: 10 }, color: ink } },
        y: { beginAtZero: true, grid: { color: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }, ticks: { precision: 0, font: { size: 10 }, color: ink } },
      },
    },
  });
}

function renderMessengerStats(data, periodLabel) {
  const t = (data && data.totals) || {};
  const texts = msgTileTexts(t);
  animateCount(document.getElementById('msgDialogs'), Number(t.dialogs) || 0);
  animateCount(document.getElementById('msgFirst'), Number(t.clientFirst) || 0);
  animateCount(document.getElementById('msgBooked'), Number(t.bookedSameDay) || 0);
  msgSetText('msgFirstShare', texts.firstShare);
  msgSetText('msgBookedPct', texts.bookedPct);
  msgSetText('msgDialogsSub', 'дней общения с клиентами · без автоуведомлений');
  msgSetSub('msgFirstSub', '#3b82f6', texts.firstSub);
  msgSetSub('msgBookedSub', 'var(--a)', texts.bookedSub);
  const chans = ((data && data.byChannel) || []).map(c => c.label).join(', ');
  msgSetText('msgPeriodSub', (periodLabel ? 'за ' + periodLabel : '') + (chans ? ' · ' + chans : ''));
  renderMessengerTable(msgChannelRows((data && data.byChannel) || [], t));
  renderMessengerChart((data && data.daily) || []);
}

// Пустое/аварийное состояние: блок не прячем, показываем прочерки.
// reason — текст ошибки ручки (например, 400 «период не больше 731 дней»):
// пользователь читает причину, а не безликое «нет данных». Только textContent.
function clearMessengerStats(reason) {
  ['msgDialogs', 'msgFirst', 'msgBooked'].forEach(id => msgSetText(id, '—'));
  ['msgFirstShare', 'msgBookedPct', 'msgPeriodSub'].forEach(id => msgSetText(id, ''));
  msgSetText('msgDialogsSub', reason || 'нет данных за период');
  msgSetSub('msgFirstSub', '', '');
  msgSetSub('msgBookedSub', '', '');
  renderMessengerTable([]);
  if (msgCh) { msgCh.destroy(); msgCh = null; }
}

// q — '?from=YYYY-MM-DD&to=YYYY-MM-DD', та же строка, что у /api/analytics/dashboard.
async function loadMessengerStats(q, periodLabel) {
  try {
    const data = await api('GET', '/api/analytics/messengers' + q);
    renderMessengerStats(data, periodLabel);
  } catch (e) {
    console.warn('Messenger stats failed:', e);
    clearMessengerStats(e && e.message);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { msgPct, msgChannelRows, msgChartSeries, msgTileTexts, MSG_CHANNEL_BADGE };
}
