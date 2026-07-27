'use strict';
// ============================================================
// Chat Events — in-memory SSE-рассылка событий чата по салонам.
// Подписчики: страница «Чат» в админке (GET /api/chat/stream).
// Источник: chatpush-webhook после сохранения сообщения.
// Однопроцессное решение (PM2 без кластера) — реестр в памяти.
// ============================================================
const subscribers = new Map(); // salonId -> Set<res>

function subscribe(salonId, res) {
  if (!subscribers.has(salonId)) subscribers.set(salonId, new Set());
  subscribers.get(salonId).add(res);
  res.on('close', () => unsubscribe(salonId, res));
}

function unsubscribe(salonId, res) {
  const set = subscribers.get(salonId);
  if (!set) return;
  set.delete(res);
  if (!set.size) subscribers.delete(salonId);
}

function emit(salonId, event) {
  const set = subscribers.get(salonId);
  if (!set || !set.size) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of [...set]) {
    try { res.write(payload); } catch { unsubscribe(salonId, res); }
  }
}

// Heartbeat: прокси/nginx рвут тихие соединения. Комментарий SSE клиентом не парсится.
const HEARTBEAT_MS = 25000;
const timer = setInterval(() => {
  for (const [salonId, set] of subscribers) {
    for (const res of [...set]) {
      try { res.write(': ping\n\n'); } catch { unsubscribe(salonId, res); }
    }
  }
}, HEARTBEAT_MS);
timer.unref(); // не держать процесс (и jest) живым из-за интервала

module.exports = { subscribe, unsubscribe, emit };
