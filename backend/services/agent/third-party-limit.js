'use strict';

// ── Анти-абьюз записей на чужие номера (аудит 2026-08-01). ──
// create_booking принимает произвольный client_phone — легитимная фича «запись
// другого человека» (жена, мама), но без лимита один диалог может насоздавать
// записей на чужие номера: людям начнут звонить из клиники (спам/травля).
// Лимит — по РАЗНЫМ посторонним номерам за окно, не по числу записей: цепочка
// book_chain для одной гостьи делает несколько create_booking с одним номером
// и не должна упираться в лимит. Повторная запись на уже «оплаченный» номер
// разрешена всегда.
// In-memory на процесс (PM2 один), рестарт сбрасывает счётчики — для анти-спама
// приемлемо, как и у дебаунса/pending-replies.

const { normalizePhoneKey } = require('../agent-gate');

const LIMIT = 3;                          // разных чужих номеров на диалог
const WINDOW_MS = 24 * 60 * 60 * 1000;    // за сутки

const buckets = new Map(); // `${salonId}|${dialogKey}` → Map(phone → lastTs)

function key(salonId, dialogKey) { return `${salonId}|${dialogKey}`; }

// Номер из input — «третье лицо», если он задан и не совпадает (после
// нормализации 8→7) с номером самого диалога. Канал без номера (Telegram/MAX):
// любой продиктованный номер считается посторонним — сверить не с чем.
function isThirdParty(inputPhone, ctxPhone) {
  const a = normalizePhoneKey(String(inputPhone || ''));
  if (!a) return false;
  const b = normalizePhoneKey(String(ctxPhone || ''));
  return !b || a !== b;
}

function livePhones(salonId, dialogKey, nowMs) {
  const k = key(salonId, dialogKey);
  const map = buckets.get(k) || new Map();
  for (const [phone, ts] of map) if (nowMs - ts >= WINDOW_MS) map.delete(phone);
  buckets.set(k, map);
  return map;
}

// Можно ли записать ЭТОТ посторонний номер: уже записанный в окне — всегда да,
// новый — только пока лимит разных номеров не исчерпан.
function allowed(salonId, dialogKey, phone, nowMs = Date.now()) {
  const p = normalizePhoneKey(String(phone || ''));
  if (!p) return true;
  const map = livePhones(salonId, dialogKey, nowMs);
  return map.has(p) || map.size < LIMIT;
}

// Зафиксировать УСПЕШНУЮ запись на посторонний номер.
function record(salonId, dialogKey, phone, nowMs = Date.now()) {
  const p = normalizePhoneKey(String(phone || ''));
  if (!p) return;
  livePhones(salonId, dialogKey, nowMs).set(p, nowMs);
}

function reset() { buckets.clear(); } // для тестов

module.exports = { isThirdParty, allowed, record, reset, LIMIT, WINDOW_MS };
