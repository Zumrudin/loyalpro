'use strict';
// ============================================================
// Рендер шаблона уведомления. Плейсхолдеры:
//   {name} {first_name} {date} {time} {end_time} {services} {staff} {salon}
//   {record_link} {rating_links}
// Чистый модуль: без БД и сети (переезд renderTemplate из services/notifications.js).
// ============================================================
const { resolveGivenName } = require('../../utils/person-name');
const { MSK_OFFSET_MS } = require('./events');

/** ms → { date:'ДД.ММ.ГГГГ', time:'ЧЧ:ММ' } по Москве; null → пустые строки. */
function fmtMsk(ms) {
  if (ms == null) return { date: '', time: '' };
  const d = new Date(ms + MSK_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

/**
 * Подстановки шаблона.
 * ctx: { name, nameDictionary?, date:'ДД.ММ.ГГГГ', time:'ЧЧ:ММ', end_time:'ЧЧ:ММ',
 *        services:'A, B', staff, salon, record_link, rating_links }
 */
function renderTemplate(text, ctx) {
  if (!text) return '';
  const c = ctx || {};
  // {first_name} — ЛИЧНОЕ имя, а не первое слово карточки: на боевой базе 77%
  // карточек это «Фамилия Имя Отчество» одной строкой, и пациенту уходило бы
  // «Вихарева, добрый вечер!». Имя не опознано → подстановка пустая, а осиротевшая
  // запятая в начале строки убирается ниже (иначе «, добрый день!»).
  const firstName = resolveGivenName(c.name, { dictionary: c.nameDictionary }) || '';
  return String(text)
    .replace(/\{name\}/g,         c.name || '')
    .replace(/\{first_name\}/g,   firstName)
    .replace(/\{date\}/g,         c.date || '')
    .replace(/\{time\}/g,         c.time || '')
    .replace(/\{end_time\}/g,     c.end_time || '')
    .replace(/\{services\}/g,     c.services || '')
    .replace(/\{staff\}/g,        c.staff || '')
    .replace(/\{salon\}/g,        c.salon || '')
    .replace(/\{record_link\}/g,  c.record_link || '')
    .replace(/\{rating_links\}/g, c.rating_links || '')
    // «{first_name}, добрый день!» без имени → «Добрый день!», а не «, добрый день!».
    .replace(/^[ \t]*,\s*(\p{L})/gmu, (_, ch) => ch.toUpperCase());
}

/**
 * Контекст рендера из снимка записи.
 * snap — events.recordSnapshot; salon — строка salons; client — строка clients|null;
 * extra — { nameDictionary, rating_links }.
 * Имя из карточки клиента главнее имени в вебхуке (в карточке полное ФИО).
 */
function buildRenderCtx(snap, salon, client, extra) {
  const start = fmtMsk(snap.visitAt);
  const end = fmtMsk(snap.visitAt != null ? snap.visitAt + (snap.seanceLength || 0) * 1000 : null);
  return {
    name: (client && client.name) || snap.clientName || '',
    nameDictionary: extra && extra.nameDictionary,
    date: start.date, time: start.time, end_time: end.time,
    services: (snap.services || []).map((s) => s.title).filter(Boolean).join(', '),
    staff: snap.staffName || '',
    salon: (salon && salon.name) || '',
    record_link: snap.shortLink || '',
    rating_links: (extra && extra.rating_links) || '',
  };
}

module.exports = { renderTemplate, buildRenderCtx, fmtMsk };
