'use strict';

const { db } = require('../../../db');
const chatEvents = require('../../chat-events');
const followupQueue = require('../followup-queue');

const schema = {
  name: 'escalate_to_operator',
  description: 'Передать диалог живому оператору и замолчать. Вызывать, когда клиент ' +
    'явно просит человека / жалуется / конфликт, ИЛИ когда база знаний не даёт ответа ' +
    'и ты не уверен — не выдумывай, эскалируй.',
  input_schema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Кратко причина эскалации.' } },
    required: ['reason'],
    additionalProperties: false,
  },
};

// ctx.dialogKey прокидывается оркестратором (Фаза 2b).
async function run(salonId, input, ctx = {}) {
  const dialogKey = ctx.dialogKey;
  const reason = String((input && input.reason) || '').slice(0, 500);
  await db.query(
    `UPDATE agent_dialogs SET status = 'escalated', escalated_reason = $3, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, reason]);
  // «Отдел заботы»: активные прохождения этого клиента — красный флаг на дашборде.
  // dialogKey для телефонных каналов = номер; для групп (g:<id>) ничего не совпадёт.
  // Отклонение от эталона: RETURNING id ограничивает второй UPDATE ровно теми
  // enrollment'ами, что помечены ЗДЕСЬ и СЕЙЧАС — не задевает старые escalated-прохождения.
  // Сбой care-каскада не должен ломать эскалацию — try/catch, не .catch() на db.query
  // (в тестах db.query всегда резолвится, но не полагаемся на форму мока сверх нужного).
  try {
    const careRes = await db.query(
      `UPDATE care_enrollments
          SET status='escalated', status_reason=$3, updated_at=NOW()
        WHERE salon_id=$1 AND phone=$2 AND status='active'
        RETURNING id`,
      [salonId, dialogKey, reason]);
    const careIds = ((careRes && careRes.rows) || []).map((r) => r.id);
    if (careIds.length) {
      await db.query(
        `UPDATE care_touch_sends SET status='cancelled', decision_reason='эскалация на оператора'
          WHERE status='scheduled' AND enrollment_id = ANY($1::bigint[])`,
        [careIds]);
    }
  } catch (e) {
    // Best-effort, но не молча: постоянный сбой каскада (например после
    // изменения схемы) должен быть виден в логах.
    console.warn(`[EscalateToOperator] care-каскад не применён: ${e.message}`);
  }
  await db.query(
    `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload)
     VALUES ($1,$2,'escalated','escalate_to_operator',$3)`,
    [salonId, dialogKey, JSON.stringify({ reason })]);
  // Диалог ждёт живого человека — подсветить его в списке чатов немедленно.
  chatEvents.emitAgentStatus(salonId, dialogKey, 'escalated', reason);
  // Дальше отвечает человек — напоминание Милы больше не нужно. Best-effort:
  // эскалация уже записана в БД и важнее гашения очереди напоминаний.
  await followupQueue.close(salonId, dialogKey, 'cancelled', 'operator')
    .catch(() => {});
  return { escalated: true, reason };
}

module.exports = { schema, run };
