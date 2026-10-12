'use strict';

// ============================================================
// Свежеотправленные ответы агента, ещё не подтверждённые эхом Chatpush.
// ------------------------------------------------------------
// Транскрипт диалога собирается из chatpush_messages, а ответы бота попадают
// туда только с эхом вебхука — по факту доставки, с задержкой от секунд до
// минут (для WhatsApp эхо не приходит вовсе). Повторный прогон, стартовавший
// сразу после отправки, видел серию клиента «без ответа» и отвечал заново —
// клиент получал два почти одинаковых ответа (инцидент 2026-07-31).
// Диспетчер запоминает здесь каждую успешно отправленную реплику, а
// history.loadTranscript подмешивает их в транскрипт (с дедупом по тексту,
// когда эхо уже легло в БД). In-memory на процесс — как и остальное состояние
// диспетчера (один PM2-процесс).
// ============================================================

// Дольше TTL эхо ждать бессмысленно: либо оно давно пришло (запись есть в БД),
// либо канал без эха (WhatsApp) — тогда старая реплика уже за пределами
// актуального окна диалога.
const TTL_MS = 30 * 60 * 1000;

const store = new Map();   // `${salonId}:${dialogKey}` → [{ text, atMs }]

function keyOf(salonId, dialogKey) { return `${salonId}:${dialogKey}`; }

// Запомнить успешно отправленную реплику. nowMs — инъекция времени для тестов.
function remember(salonId, dialogKey, text, nowMs = Date.now()) {
  if (!text || !String(text).trim()) return;
  const k = keyOf(salonId, dialogKey);
  const list = store.get(k) || [];
  list.push({ text: String(text), atMs: nowMs });
  store.set(k, list);
}

// Живые (не протухшие) реплики диалога в порядке отправки.
// Возвращает [{ text, ts }], ts — unix-секунды (как msg_ts в chatpush_messages).
function peek(salonId, dialogKey, nowMs = Date.now()) {
  const k = keyOf(salonId, dialogKey);
  const list = store.get(k);
  if (!list) return [];
  const alive = list.filter((e) => nowMs - e.atMs <= TTL_MS);
  if (alive.length) store.set(k, alive); else store.delete(k);
  return alive.map((e) => ({ text: e.text, ts: Math.floor(e.atMs / 1000) }));
}

// Удаляем только уже сохранённые ответы. Само подтверждение доставки ещё
// не доказывает наличие строки в истории. Старое эхо не гасит более новую
// отправку такого же текста; чужие салоны/диалоги имеют отдельные ключи.
function acknowledge(salonId, dialogKey, rows) {
  const k = keyOf(salonId, dialogKey);
  const list = store.get(k);
  if (!list) return;
  const remaining = list.filter(e => !(rows || []).some(r => r && r.text === e.text
    && Number.isFinite(Number(r.msg_ts)) && Number(r.msg_ts) > 0
    && Number(r.msg_ts) >= Math.floor(e.atMs / 1000)));
  if (remaining.length) store.set(k, remaining); else store.delete(k);
}

// Сброс — только для тестов.
function _reset() { store.clear(); }

module.exports = { remember, peek, acknowledge, _reset };
