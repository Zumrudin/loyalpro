'use strict';

// ── Кэш вариантов get_sequential_slots для book_chain. ──────────────────────
// Модель больше не переписывает chain руками (источник ошибок booking_mode):
// get_sequential_slots помечает каждый старт option_id и кладёт цепочку сюда,
// book_chain забирает её по option_id и оформляет детерминированно.
// In-memory на один PM2-процесс (тот же компромисс, что дебаунс диспетчера);
// рестарт/TTL → book_chain вернёт option_expired, модель перезапросит слоты.

const TTL_MS = 30 * 60 * 1000;
const MAX_DIALOGS = 500;   // страховка от утечки: старейший диалог вытесняется

const store = new Map();   // `${salonId}:${dialogKey}` → { at, offers }

const keyOf = (salonId, dialogKey) => `${salonId}:${dialogKey}`;

function remember(salonId, dialogKey, offers, opts = {}) {
  const now = opts.nowMs || Date.now();
  const k = keyOf(salonId, dialogKey);
  store.delete(k);   // переставить в конец (Map хранит порядок вставки)
  store.set(k, { at: now, offers: offers || {} });
  while (store.size > MAX_DIALOGS) store.delete(store.keys().next().value);
}

// take НЕ удаляет запись — ретрай book_chain после сетевого сбоя должен мочь перечитать тот же вариант
function take(salonId, dialogKey, optionId, opts = {}) {
  const now = opts.nowMs || Date.now();
  const entry = store.get(keyOf(salonId, dialogKey));
  if (!entry || now - entry.at > TTL_MS) return null;
  return Object.prototype.hasOwnProperty.call(entry.offers, optionId) ? (entry.offers[optionId] || null) : null;
}

// peek — весь живой набор вариантов диалога (или null). Нужен системному промпту:
// модель видит option_id только в результате инструмента ТОГО хода, а транскрипт
// пересобирается из текстов сообщений — на следующем ходу («давайте первый») id
// уже потерян. НЕ потребляет и НЕ клонирует: chain — разделяемая с book_chain и
// с телом ответа инструмента ссылка, читать можно, мутировать нельзя.
function peek(salonId, dialogKey, opts = {}) {
  const now = opts.nowMs || Date.now();
  const entry = store.get(keyOf(salonId, dialogKey));
  if (!entry || now - entry.at > TTL_MS) return null;
  return entry.offers || null;
}

// ── Рендер вариантов в строки для промпта. Чистая функция. ──────────────────
// Живёт рядом с кэшем, а не в system-prompt.js: промпт остаётся не знающим о
// форме chain (её задаёт get_sequential_slots и хранит этот модуль), а
// оркестратору достаточно одного require.

const LINE_MAX = 300;

// Название услуги/мастера приходит из YClients — в промпт только одной строкой
// (перенос строки внутри = дописать агенту «правила»).
const clean = (v, max = 60) => String(v == null ? '' : v)
  .replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

// '2026-07-30T10:30:00+03:00' → { date:'30.07', time:'10:30' }; иначе null.
function parseDt(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(raw == null ? '' : raw));
  return m ? { date: `${m[3]}.${m[2]}`, time: `${m[4]}:${m[5]}` } : null;
}

function renderLink(link) {
  if (!link || typeof link !== 'object') return null;
  const dt = parseDt(link.datetime);
  if (!dt) return null;                       // без времени звено бесполезно — молча пропускаем
  const title = clean(link.service_title) || 'процедура';
  const notes = [];
  const who = clean(link.staff_name, 40)
    || (link.staff_yc_id == null || link.staff_yc_id === '' ? '' : `мастер ${clean(link.staff_yc_id, 20)}`);
  if (who) notes.push(who);
  if (link.already_booked) notes.push('уже записана');
  return `${dt.time} «${title}»${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

// Порядок строго по ЧИСЛУ в option_id: o10 идёт после o2, а не после o1.
const optionNum = (id) => {
  const m = /^o(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

function renderOffers(offers) {
  if (!offers || typeof offers !== 'object') return [];
  const ids = Object.keys(offers).sort((a, b) =>
    (optionNum(a) - optionNum(b)) || (a < b ? -1 : a > b ? 1 : 0));
  const lines = [];
  for (const id of ids) {
    const offer = offers[id];
    const chain = offer && Array.isArray(offer.chain) ? offer.chain : null;
    if (!chain || !chain.length) continue;
    const links = chain.map(renderLink).filter(Boolean);
    if (!links.length) continue;
    const day = chain.map(l => parseDt(l && l.datetime)).find(Boolean);
    lines.push(`${clean(id, 12)} — ${day.date}: ${links.join(' → ')}`.slice(0, LINE_MAX));
  }
  return lines;
}

function _reset() { store.clear(); }

module.exports = { remember, take, peek, renderOffers, TTL_MS, _reset };
