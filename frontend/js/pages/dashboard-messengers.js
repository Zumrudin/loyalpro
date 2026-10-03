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
  if (Object.hasOwn(MSG_CHANNEL_BADGE, channel)) return MSG_CHANNEL_BADGE[channel];
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { msgPct, msgChannelRows, msgChartSeries, msgTileTexts, MSG_CHANNEL_BADGE };
}
