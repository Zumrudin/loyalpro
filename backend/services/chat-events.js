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

// Смена режима диалога (бот ↔ оператор). Список диалогов в админке красит
// такие диалоги и поднимает наверх — без этого события подсветка появлялась бы
// только на страховочном опросе раз в 30 сек.
// Зовётся отовсюду, где меняется agent_dialogs.status: эскалация агента,
// ручной ответ оператора, кнопка «Передать оператору»/«Вернуть боту».
function emitAgentStatus(salonId, dialogKey, status, reason = null) {
  emit(salonId, { type: 'agent_status', dialogKey, status, reason: reason || null });
}

// Смена стадии ожидания ответа клиента: чип в списке диалогов обязан
// обновиться без F5 — список перестраивается локально по SSE.
function emitFollowupStatus(salonId, dialogKey, status, stage = 0) {
  emit(salonId, { type: 'followup_status', dialogKey, status, stage: Number(stage) || 0 });
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

module.exports = { subscribe, unsubscribe, emit, emitAgentStatus, emitFollowupStatus };
