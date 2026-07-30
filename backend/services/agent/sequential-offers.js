'use strict';

// ── Кэш вариантов get_sequential_slots для book_chain. ──────────────────────
// Модель больше не переписывает chain руками (источник ошибок booking_mode):
// get_sequential_slots помечает каждый старт option_id и кладёт цепочку сюда,
// book_chain забирает её по option_id и оформляет детерминированно.
// In-memory на один PM2-процесс (тот же компромисс, что дебаунс диспетчера);
// рестарт/TTL → book_chain вернёт option_expired, модель перезапросит слоты.

const { sanitizeLine } = require('./sanitize');

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

// markBooked — вариант оформлен book_chain: в промпте его больше не показываем
// (слот занят нами же, а кэш живёт до 30 минут). Флаг ставим на САМ вариант, а не
// на chain: цепочка — разделяемая ссылка и остаётся read-only. take по-прежнему
// отдаёт вариант, чтобы идемпотентный ретрай book_chain с тем же option_id работал.
function markBooked(salonId, dialogKey, optionId, opts = {}) {
  const now = opts.nowMs || Date.now();
  const entry = store.get(keyOf(salonId, dialogKey));
  if (!entry || now - entry.at > TTL_MS) return false;
  if (!Object.prototype.hasOwnProperty.call(entry.offers, optionId)) return false;
  const offer = entry.offers[optionId];
  if (!offer || typeof offer !== 'object') return false;
  offer.booked = true;
  return true;
}

// ── Рендер вариантов в строки для промпта. Чистая функция. ──────────────────
// Живёт рядом с кэшем, а не в system-prompt.js: промпт остаётся не знающим о
// форме chain (её задаёт get_sequential_slots и хранит этот модуль), а
// оркестратору достаточно одного require.
// ГЛАВНОЕ ПРАВИЛО: вариант показывается ТОЛЬКО ЦЕЛИКОМ. book_chain оформит ВСЕ
// звенья цепочки, поэтому урезанная строка (обрезка по длине или пропуск
// нечитаемого звена) = молчаливая запись пациента на процедуру, которую ему не
// назвали. Не влезает или не читается — выбрасываем вариант целиком, модель
// перезапросит get_sequential_slots.

const MAX_RENDERED_OPTIONS = 8;   // потолок инструмента — 6 вариантов × 4 старта = 24 строки: и промпт пухнет, и allowedTimes reply-guard размывается
const LINE_MAX = 420;             // ≈ префикс (13) + 3 звена по максимуму полей (~125) + разделители
const TITLE_MAX = 60;
const STAFF_MAX = 40;

// '2026-07-30T10:30:00+03:00' → { date:'30.07', time:'10:30' }; иначе null.
function parseDt(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(raw == null ? '' : raw));
  return m ? { date: `${m[3]}.${m[2]}`, time: `${m[4]}:${m[5]}` } : null;
}

function renderLink(link) {
  if (!link || typeof link !== 'object') return null;
  const dt = parseDt(link.datetime);
  if (!dt) return null;                       // нечитаемое звено → вариант отбрасывается целиком (см. вызов)
  const title = sanitizeLine(link.service_title, TITLE_MAX) || 'процедура';
  const notes = [];
  // Имени мастера нет — yc_id НЕ подставляем: это внутренний идентификатор
  // (правило 9 промпта, id_leak в reply-guard), а модели он ничего не даёт —
  // book_chain принимает только option_id.
  const who = sanitizeLine(link.staff_name, STAFF_MAX);
  if (who) notes.push(who);
  if (link.already_booked) notes.push('уже записана');
  return `${dt.time} «${title}»${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

// Порядок строго по ЧИСЛУ в option_id: o10 идёт после o2, а не после o1.
const optionNum = (id) => {
  const m = /^o(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

function renderOffers(offers, opts = {}) {
  if (!offers || typeof offers !== 'object') return [];
  const now = opts.nowMs || Date.now();
  const ids = Object.keys(offers).sort((a, b) =>
    (optionNum(a) - optionNum(b)) || (a < b ? -1 : a > b ? 1 : 0));
  const lines = [];
  for (const id of ids) {
    if (lines.length >= MAX_RENDERED_OPTIONS) break;   // режем ХВОСТ: первые варианты приоритетнее (same_staff идёт первым)
    const offer = offers[id];
    if (!offer || typeof offer !== 'object' || offer.booked) continue;
    const chain = Array.isArray(offer.chain) ? offer.chain : null;
    if (!chain || !chain.length) continue;
    const day = parseDt(chain[0] && chain[0].datetime);
    if (!day) continue;
    // Старт уже прошёл — предлагать нельзя. get_sequential_slots отрезает прошедшее
    // время, кэш же живёт до 30 минут: иначе модель предложит прошлое → create_booking
    // провалится → принудительный перевод на человека (инцидент 2026-07-28).
    const startMs = Date.parse(chain[0].datetime);
    if (!Number.isFinite(startMs) || startMs <= now) continue;
    const links = chain.map(renderLink);
    if (links.some(l => !l)) continue;                 // хоть одно звено не отрисовалось → вариант мимо
    const line = `${sanitizeLine(id, 12)} — ${day.date}: ${links.join(' → ')}`;
    if (line.length > LINE_MAX) continue;              // не режем по середине — выбрасываем вариант
    lines.push(line);
  }
  return lines;
}

function _reset() { store.clear(); }

module.exports = {
  remember, take, peek, markBooked, renderOffers,
  TTL_MS, MAX_RENDERED_OPTIONS, _reset,
};
