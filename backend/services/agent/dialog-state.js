'use strict';

const { db } = require('../../db');

// ── Состояние диалога агента (agent_dialogs). Тонкие обёртки над SQL. ──

// Гарантированно вернуть строку диалога (создать при первом обращении).
async function getOrCreate(salonId, dialogKey) {
  return db.one(
    `INSERT INTO agent_dialogs (salon_id, dialog_key)
     VALUES ($1, $2)
     ON CONFLICT (salon_id, dialog_key)
       DO UPDATE SET last_activity = now()
     RETURNING id, salon_id, dialog_key, status, collected, watermark_ts, dirty, escalated_reason`,
    [salonId, dialogKey]);
}

async function get(salonId, dialogKey) {
  return db.oneOrNone(
    `SELECT id, status, collected, watermark_ts, dirty, escalated_reason
       FROM agent_dialogs WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey]);
}

// Зафиксировать прочитанную водяную метку и сбросить dirty после успешного хода.
async function setWatermark(salonId, dialogKey, watermark) {
  await db.query(
    `UPDATE agent_dialogs
        SET watermark_ts = $3, dirty = false, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, watermark || 0]);
}

// Сменить статус (bot ↔ escalated ↔ closed). reason — для escalated.
async function setStatus(salonId, dialogKey, status, reason = null) {
  await db.query(
    `UPDATE agent_dialogs
        SET status = $3, escalated_reason = $4, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, status, reason]);
}

// Пауза «дальше отвечает человек». Два входа, и правило у них одно:
//   • оператор написал через админку (routes/chat.js);
//   • оператор написал прямо из приложения Chatpush/MAX — это видно только по
//     эху входящего вебхука (routes/chatpush-webhook.js).
// Второго входа не было до 2026-08-04, и Мила вмешивалась в диалог, который
// четвёртые сутки вёл администратор: дочитывала его реплики как свои и оформила
// запись на выдуманную услугу. Снимается кнопкой «Вернуть боту».
// Upsert, а не UPDATE: строки диалога может ещё не быть (бот не отвечал).
async function pauseForOperator(salonId, dialogKey) {
  await db.query(
    `INSERT INTO agent_dialogs (salon_id, dialog_key, status, escalated_reason)
     VALUES ($1, $2, 'escalated', 'operator_reply')
     ON CONFLICT (salon_id, dialog_key)
       DO UPDATE SET status='escalated', escalated_reason='operator_reply', updated_at=now()`,
    [salonId, dialogKey]);
  // Требуем лениво: chat-events тянет за собой express-слой, а dialog-state
  // подключается в юнит-тестах агента без него.
  require('../chat-events').emitAgentStatus(salonId, dialogKey, 'escalated', 'operator_reply');
}

// Снять паузу «отвечал администратор», если её поставили ДО открытия текущего
// окна расписания. Ночью администраторов нет, отвечать всё равно некому, а без
// автосброса красный диалог не вернётся боту никогда (на проде это ≈24%
// диалогов за неделю — Мила замолчала бы на большей части активной базы).
// Правила снятия — в resumeOperatorPauses, здесь только вход «по одному диалогу».
// Входов у правила ДВА, и SQL у них обязан быть один (см. resumeOperatorPauses):
//   • ленивый — приход сообщения в диспетчере (мгновенно, но только по тому
//     диалогу, в который написали, и только внутри окна);
//   • фоновый проход operator-pause-sweep (вечерний сброс всей базы).
// Ленивого ОДНОГО не хватило: у PERI окно ночное, ночью клиенты почти не пишут —
// за трое суток прода ноль снятий, администраторы возвращали диалоги боту руками.
// @param {number} minutesSinceWindowStart см. agent-gate.minutesSinceWindowStart
// @returns {Promise<boolean>} снята ли пауза
async function resumeOperatorPauseIfWindowReopened(salonId, dialogKey, minutesSinceWindowStart) {
  if (!dialogKey) return false;
  const resumed = await resumeOperatorPauses(salonId, [dialogKey], minutesSinceWindowStart);
  return resumed.length > 0;
}

// Кандидаты на вечерний сброс: паузы администратора, поставленные ДО открытия
// текущего окна. Отдельный SELECT, а не UPDATE … RETURNING, потому что до записи
// каждый ключ надо прогнать через гейт допуска (чёрный/белый список): снимать
// паузу у номера, которому Мила всё равно не ответит, значит красить диалог в
// «бот» и оставлять клиента без ответа.
async function listStaleOperatorPauses(salonId, minutesSinceWindowStart) {
  if (!salonId || typeof minutesSinceWindowStart !== 'number') return [];
  const rows = await db.any(
    `SELECT dialog_key FROM agent_dialogs
      WHERE salon_id = $1
        AND status = 'escalated' AND escalated_reason = 'operator_reply'
        AND updated_at < now() - ($2 || ' minutes')::interval
      ORDER BY updated_at`,
    [salonId, minutesInterval(minutesSinceWindowStart)]);
  return rows.map(r => r.dialog_key);
}

// Снять паузу «отвечал администратор» пачкой ключей. Возвращает РЕАЛЬНО снятые.
//   • трогаем ТОЛЬКО escalated_reason='operator_reply'. Настоящая эскалация
//     Милы (escalate_to_operator, «клиент недоволен», «осложнение») остаётся
//     на человеке навсегда — её снимает только кнопка «Вернуть боту»;
//   • escalated_reason гасим: блок промпта «диалог вернул тебе администратор»
//     говорит о разрешённом КОНФЛИКТЕ, а здесь конфликта не было;
//   • возраст строки проверяем В SQL (NOW() - interval), а не меткой из JS: так
//     условие перепроверяется в момент записи, и ответ администратора, пришедший
//     между выборкой кандидатов и этим UPDATE, паузу удержит.
async function resumeOperatorPauses(salonId, dialogKeys, minutesSinceWindowStart) {
  const keys = (dialogKeys || []).filter(Boolean);
  if (!salonId || !keys.length || typeof minutesSinceWindowStart !== 'number') return [];
  const { rows } = await db.query(
    `UPDATE agent_dialogs
        SET status = 'bot', escalated_reason = NULL, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = ANY($2)
        AND status = 'escalated' AND escalated_reason = 'operator_reply'
        AND updated_at < now() - ($3 || ' minutes')::interval
      RETURNING dialog_key`,
    [salonId, keys, minutesInterval(minutesSinceWindowStart)]);
  // Требуем лениво: chat-events тянет за собой express-слой, а dialog-state
  // подключается в юнит-тестах агента без него.
  const events = rows.length ? require('../chat-events') : null;
  for (const r of rows) events.emitAgentStatus(salonId, r.dialog_key, 'bot', null);
  return rows.map(r => r.dialog_key);
}

// Минуты → безопасная строка для ($n || ' minutes')::interval.
function minutesInterval(minutes) {
  return String(Math.max(0, Math.floor(minutes)));
}

module.exports = {
  getOrCreate, get, setWatermark, setStatus, pauseForOperator,
  resumeOperatorPauseIfWindowReopened, listStaleOperatorPauses, resumeOperatorPauses,
};
