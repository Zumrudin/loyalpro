'use strict';

const { db } = require('../../db');

// Ключ диалога в chatpush_messages — тот же, что во всём коде (routes/chat.js):
// телефон, либо chat_id для каналов без телефона (Telegram/MAX).
const DIALOG_KEY_SQL = `COALESCE(NULLIF(phone,''), chat_id)`;

// Транскрипт диалога для Claude Messages API.
//  incoming → {role:'user'}, outgoing (наши эхо-ответы) → {role:'assistant'}.
// Возвращает { messages, watermark }, где watermark = max(msg_ts) входящих.
async function loadTranscript(salonId, dialogKey, opts = {}) {
  const limit = opts.limit || 20;
  const rows = await db.any(
    `SELECT direction, msg_type, text, msg_ts
       FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND text IS NOT NULL AND text <> ''
      ORDER BY msg_ts DESC, id DESC
      LIMIT $3`,
    [salonId, dialogKey, limit]);

  rows.reverse();   // из DESC (свежие сверху) → в хронологический порядок

  const messages = [];
  let watermark = 0;
  for (const r of rows) {
    if (r.direction === 'incoming' && Number(r.msg_ts) > watermark) watermark = Number(r.msg_ts);
    const role = r.direction === 'outgoing' ? 'assistant' : 'user';
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n${r.text}`;   // склейка серии
    else messages.push({ role, content: r.text });
  }
  // Claude требует, чтобы первым шёл user — срезаем ведущие assistant-реплики.
  while (messages.length && messages[0].role === 'assistant') messages.shift();
  return { messages, watermark };
}

// Пришло ли входящее новее watermark (во время прогона агента)?
async function hasIncomingAfter(salonId, dialogKey, watermark) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND direction = 'incoming' AND msg_ts > $3
      LIMIT 1`,
    [salonId, dialogKey, watermark || 0]);
  return !!row;
}

module.exports = { loadTranscript, hasIncomingAfter };
