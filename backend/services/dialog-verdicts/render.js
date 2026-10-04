// backend/services/dialog-verdicts/render.js
'use strict';
// ============================================================
// Текст одного диалог-дня для модели. Чистый модуль, тесты dialog-verdicts-render.test.js.
// Роли: «клиент:» — входящее; «клиника:» — исходящее администратора/Милы;
// «авто:» — исходящее с authored_by='system' (автоуведомления YClients). Авто
// ВКЛЮЧАЮТСЯ намеренно: без них модель не видит «Напоминаем о записи», на которое
// клиент ответил, и «Вы записаны на прием», которым разговор закончился.
// Хвост предыдущих дней — контекст, модели сказано его не оценивать.
// Обрезки: сообщение 600, диалог-день 4000; при переполнении первым уходит
// хвост, затем НАЧАЛО дня (исход разговора — в конце). Санитизация — та же
// sanitizeLine, что у промпта Милы (текст сообщений клиент-контролируемый).
// ВХОД: сообщения ОДНОГО диалога по возрастанию времени (msg_ts, id). dayMessages —
// сообщения того московского дня, который оцениваем; tailMessages — ТОЛЬКО более
// ранние дни (строки следующего дня сюда не попадают: они нужны лишь detectNotified,
// а он принимает ВСЕ загруженные строки диалога, включая следующий день).
// day и m.day — текст 'YYYY-MM-DD' (московская дата), а не pg Date.
// ============================================================
const { sanitizeLine } = require('../agent/sanitize');
const { isMedia } = require('../chat');
const { BOOKING_NOTICE_RE } = require('./taxonomy');

const MSG_MAX = 600;
const DAY_MAX = 4000;
const TAIL_MAX = 10;
const TAIL_HEAD = '--- предыдущие дни ---';
const DAY_HEAD = '--- этот день ---';

function role(m) {
  if (m.direction === 'incoming') return 'клиент';
  return m.authored_by === 'system' ? 'авто' : 'клиника';
}

// Одна строка транскрипта или '' (пустое сообщение пропускается).
function line(m) {
  let t = sanitizeLine(m.text, MSG_MAX);
  if (!t && isMedia(m.msg_type)) t = '[файл]';
  return t ? `${role(m)}: ${t}` : '';
}

function renderDialogDay({ dayMessages, tailMessages } = {}) {
  const dayLines = (dayMessages || []).map(line).filter(Boolean);
  let tailLines = (tailMessages || []).slice(-TAIL_MAX).map(line).filter(Boolean);
  let cut = false;
  const build = () => {
    const parts = [];
    if (tailLines.length) parts.push(TAIL_HEAD, ...tailLines);
    parts.push(DAY_HEAD);
    if (cut) parts.push('…');
    parts.push(...dayLines);
    return parts.join('\n');
  };
  let out = build();
  while (out.length > DAY_MAX && tailLines.length) { tailLines = tailLines.slice(1); out = build(); }
  while (out.length > DAY_MAX && dayLines.length > 1) { dayLines.shift(); cut = true; out = build(); }
  return out.length > DAY_MAX ? out.slice(0, DAY_MAX) : out;
}

function nextDay(day) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// messages — строки с полем day ('YYYY-MM-DD', московская дата сообщения).
// Уведомление о созданной записи считается за этот день И за следующий: запись,
// оформленная вечером, уведомляется той же минутой, но эхо может лечь после полуночи.
function detectNotified(messages, day) {
  const days = new Set([day, nextDay(day)]);
  return (messages || []).some(m => m.direction === 'outgoing' && m.authored_by === 'system'
    && days.has(m.day) && BOOKING_NOTICE_RE.test(String(m.text || '')));
}

module.exports = { renderDialogDay, detectNotified, nextDay, MSG_MAX, DAY_MAX, TAIL_MAX, TAIL_HEAD, DAY_HEAD };
