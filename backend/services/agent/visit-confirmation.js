'use strict';

// A confirmation is terminal only within this reminder exchange. Neither a
// patient's "yes" nor a generated assistant claim proves CRM confirmation.
const { DIALOG_KEY_SQL } = require('../chat');
const MAX_ACK_SECONDS = 30 * 60;
const MAX_REMINDER_SECONDS = 48 * 60 * 60;
const TS_SQL = `COALESCE(msg_ts, EXTRACT(EPOCH FROM (created_at AT TIME ZONE 'Europe/Moscow'))::bigint)`;

function clean(text) {
  return typeof text === 'string' ? text.toLowerCase().replace(/ё/g, 'е').trim() : '';
}
function isReminder(text) {
  const s = clean(text);
  return /запис|прием|визит/.test(s) && /подтвердите|подтверждени[яе]|подтверждаете/.test(s)
    && !/не подтвержден|отменен/.test(s);
}
function isAcknowledgement(text) {
  const s = clean(text);
  return !/[?]/u.test(s) && !/(?:^|\s)не\s|отмен|ошиб|не удалось/.test(s)
    && /(?:запись|визит|прием)\s+(?:успешно\s+)?подтвержден[ао]?(?:[\s.!✅]|$)/u.test(s);
}
function isPureConfirmation(text) {
  // Remove only closed, polite prefixes/suffixes. Never erase arbitrary words,
  // negation or question marks: a confirmation may contain a new request.
  let s = clean(text).replace(/[.! ,\s✅👍🙏]+/gu, ' ').trim();
  s = s.replace(/^(?:здравствуйте|добрый день|добрый вечер|доброе утро) /u, '')
    .replace(/ (?:спасибо|благодарю)$/u, '');
  return /^(?:\+|да+|(?:да+ )?(?:я )?(?:обязательно )?(?:буду|приду)|(?:да+ )?(?:подтверждаю|подверждаю|потверждаю)(?: запись| визит| прием)?|запись подтверждаю)$/.test(s);
}

// Rows must be in chronological order (message timestamp, id). All incoming
// messages since the reminder must be pure confirmations: "yes" after an
// unanswered request to reschedule must not swallow that request.
function conversationComplete(rows) {
  if (!Array.isArray(rows)) return false;
  const lastIncoming = rows.findLastIndex(r => r.direction === 'incoming');
  if (lastIncoming < 0) return false;
  let start = lastIncoming - 1;
  while (start >= 0 && !(rows[start].direction === 'outgoing'
    && rows[start].authored_by === 'system' && isReminder(rows[start].text))) start--;
  if (start < 0) return false;
  const exchange = rows.slice(start + 1);
  const replyAt = Number(rows[lastIncoming].msg_ts);
  const reminderAt = Number(rows[start].msg_ts);
  if (!Number.isFinite(replyAt) || !Number.isFinite(reminderAt)
      || replyAt < reminderAt || replyAt - reminderAt > MAX_REMINDER_SECONDS) return false;
  if (exchange.some(r => r.direction === 'incoming' && !isPureConfirmation(r.text))) return false;
  // An intervening human/agent question makes this a different exchange.
  if (rows.slice(start + 1, lastIncoming).some(r => r.direction === 'outgoing'
      && r.authored_by !== 'system')) return false;
  return rows.slice(lastIncoming + 1).some(r => r.direction === 'outgoing'
    && r.authored_by === 'system' && isAcknowledgement(r.text)
    && Number(r.msg_ts) >= replyAt && Number(r.msg_ts) - replyAt <= MAX_ACK_SECONDS);
}

async function loadRows(db, salonId, dialogKey) {
  const rows = await db.any(
    `SELECT direction, authored_by, text, ${TS_SQL} AS msg_ts
       FROM chatpush_messages
      WHERE salon_id=$1 AND ${DIALOG_KEY_SQL}=$2
      ORDER BY ${TS_SQL} DESC, id DESC LIMIT 40`, [salonId, dialogKey]);
  return rows.slice().reverse();
}

async function loadConversationComplete(db, salonId, dialogKey) {
  return conversationComplete(await loadRows(db, salonId, dialogKey));
}

module.exports = { loadRows, conversationComplete, loadConversationComplete, isPureConfirmation,
  isReminder, isAcknowledgement };
