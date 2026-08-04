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
//   • трогаем ТОЛЬКО escalated_reason='operator_reply'. Настоящая эскалация
//     Милы (escalate_to_operator, «клиент недоволен», «осложнение») остаётся
//     на человеке навсегда — её снимает только кнопка «Вернуть боту»;
//   • escalated_reason гасим: блок промпта «диалог вернул тебе администратор»
//     говорит о разрешённом КОНФЛИКТЕ, а здесь конфликта не было;
//   • сравнение возрастом строки в SQL (NOW() - interval), а не меткой из JS:
//     agent_dialogs.updated_at — `timestamp without time zone`, и передавать
//     туда JS-Date значит зависеть от часового пояса соединения.
// @param {number} minutesSinceWindowStart см. agent-gate.minutesSinceWindowStart
// @returns {Promise<boolean>} снята ли пауза
async function resumeOperatorPauseIfWindowReopened(salonId, dialogKey, minutesSinceWindowStart) {
  if (!salonId || !dialogKey || typeof minutesSinceWindowStart !== 'number') return false;
  const { rowCount } = await db.query(
    `UPDATE agent_dialogs
        SET status = 'bot', escalated_reason = NULL, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2
        AND status = 'escalated' AND escalated_reason = 'operator_reply'
        AND updated_at < now() - ($3 || ' minutes')::interval`,
    [salonId, dialogKey, String(Math.max(0, Math.floor(minutesSinceWindowStart)))]);
  if (rowCount) {
    require('../chat-events').emitAgentStatus(salonId, dialogKey, 'bot', null);
  }
  return rowCount > 0;
}

module.exports = {
  getOrCreate, get, setWatermark, setStatus, pauseForOperator,
  resumeOperatorPauseIfWindowReopened,
};
