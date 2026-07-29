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

function take(salonId, dialogKey, optionId, opts = {}) {
  const now = opts.nowMs || Date.now();
  const entry = store.get(keyOf(salonId, dialogKey));
  if (!entry || now - entry.at > TTL_MS) return null;
  return entry.offers[optionId] || null;
}

function _reset() { store.clear(); }

module.exports = { remember, take, TTL_MS, _reset };
