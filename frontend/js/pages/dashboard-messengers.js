// ── ДАШБОРД: блок «Переписки в мессенджерах» ─────────────────────────────
// Спека: docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md,
// колонки статусов — docs/superpowers/specs/2026-10-04-dialog-verdicts-design.md.
// Данные — GET /api/analytics/messengers?from&to (та же пара дат, что у
// остального дашборда). Проценты считает фронт, бэкенд отдаёт только счётчики.
// Файл подключён обычным <script> и делит глобальную область с dashboard.js и
// dashboard-verdicts.js: никаких верхнеуровневых имён, уже занятых там.
// Зависимости из core: api(), esc(), animateCount(). График по дням убран
// 2026-10-04 (решение владельца): его место заняли колонки статусов.

const MSG_CHANNEL_BADGE = {
  tdlib:    { short: 'TG', cls: 'ch-tg' },
  whatsapp: { short: 'WA', cls: 'ch-wa' },
  max:      { short: 'M',  cls: 'ch-max' },
};

// Колонки статусов. Коды и порядок — КОПИЯ backend/services/dialog-verdicts/taxonomy.js
// (фронт бэкенд не require'ит); расхождение ловит node-тест этого файла.
const MSG_VERDICT_COLS = [
  { code: 'booked',          short: 'Записался',   title: 'Записался: клиника подтвердила дату и время или пришло авто «Вы записаны»' },
  { code: 'declined',        short: 'Отказ',       title: 'Отказ или тишина после предложенного времени' },
  { code: 'pending',         short: 'Не доведён',  title: 'Запрос был, до записи не дошли: цена, «подумаю», уточнения' },
  { code: 'reschedule',      short: 'Перенос',     title: 'Перенос или отмена существующей записи' },
  { code: 'question',        short: 'Вопрос',      title: 'Вопрос без намерения записаться' },
  { code: 'broadcast_reply', short: 'Рассылка',    title: 'Ответ на рассылку, напоминание или оценку визита' },
  { code: 'no_dialog',       short: 'Без общения', title: 'Содержательного общения нет' },
  { code: 'other',           short: 'Другое',      title: 'Ни один статус не подошёл' },
  { code: 'unanalyzed',      short: 'Не разобр.',  title: 'Ещё не проанализировано ИИ' },
];

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

function msgVerdicts(v) {
  const out = {};
  for (const c of MSG_VERDICT_COLS) out[c.code] = Number(v && v[c.code]) || 0;
  return out;
}

function msgRow(label, badge, s, isTotal, channel) {
  return {
    label, short: badge.short, cls: badge.cls, channel: channel || '',
    dialogs: Number(s.dialogs) || 0,
    clientFirst: Number(s.clientFirst) || 0,
    bookedSameDay: Number(s.bookedSameDay) || 0,
    conv: msgPct(s.bookedSameDay, s.clientFirst),
    convPct: msgConvPct(s.bookedSameDay, s.clientFirst),
    isTotal,
    verdicts: msgVerdicts(s.verdicts),
  };
}

function msgChannelRows(byChannel, totals) {
  const rows = (byChannel || []).map(c => msgRow(c.label || c.channel, msgBadge(c.channel), c, false, c.channel));
  rows.push(msgRow('Все каналы', { short: 'Σ', cls: 'ch-all' }, totals || {}, true, ''));
  return rows;
}

// Описание колонок таблицы — один источник для thead и tbody.
function msgTableColumns() {
  return [
    { key: 'label', th: 'Канал' },
    { key: 'dialogs', th: 'Диалогов' },
    { key: 'clientFirst', th: 'Первым' },
    { key: 'bookedSameDay', th: 'Записались (CRM)' },
    { key: 'conv', th: 'Конверсия' },
    ...MSG_VERDICT_COLS.map(c => ({ key: 'v:' + c.code, th: c.short, title: c.title, code: c.code })),
  ];
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
function msgSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function msgSetSub(id, dotColor, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (dotColor ? '<span class="dot" style="background:' + dotColor + '"></span>' : '') + esc(text);
}

function renderMessengerThead() {
  const tr = document.getElementById('msgThead');
  if (!tr) return;
  tr.innerHTML = msgTableColumns().map(c =>
    `<th${c.title ? ' title="' + esc(c.title) + '"' : ''}${c.code ? ' class="vd-th"' : ''}>${esc(c.th)}</th>`).join('');
}

// Ячейка статуса: число > 0 — кнопка детализации (data-ch/data-st читает dashboard-verdicts.js).
function msgVerdictCell(r, code) {
  const n = r.verdicts[code];
  if (!n) return '<td class="vd-n">0</td>';
  return `<td class="vd-n"><button type="button" class="vd-cell" data-ch="${esc(r.channel)}" data-st="${esc(code)}">${n}</button></td>`;
}

function renderMessengerTable(rows) {
  renderMessengerThead();
  const tbody = document.getElementById('msgTbody');
  if (!tbody) return;
  const cols = msgTableColumns().length;
  const dataRows = rows.filter(r => !r.isTotal);
  if (!dataRows.length) { tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">Нет данных</td></tr>`; return; }
  tbody.innerHTML = rows.map(r => `
    <tr${r.isTotal ? ' class="total"' : ''}>
      <td><span class="ch ${esc(r.cls)}"><i>${esc(r.short)}</i>${esc(r.label)}</span></td>
      <td>${r.dialogs}</td>
      <td>${r.clientFirst}</td>
      <td>${r.bookedSameDay}</td>
      <td><span class="conv"><span class="pb"><span class="pf" style="width:${r.convPct}%"></span></span><b>${esc(r.conv)}</b></span></td>
      ${MSG_VERDICT_COLS.map(c => msgVerdictCell(r, c.code)).join('')}
    </tr>`).join('');
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
  // Детализация (dashboard-verdicts.js) синхронизируется с адресом ПОСЛЕ таблицы:
  // список контактов зависит от периода, а при F5 внутри переписки адрес уже есть.
  if (typeof vdAfterRender === 'function') vdAfterRender();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { msgPct, msgChannelRows, msgTileTexts, msgTableColumns, MSG_CHANNEL_BADGE, MSG_VERDICT_COLS };
}
