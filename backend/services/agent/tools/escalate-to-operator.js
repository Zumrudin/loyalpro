'use strict';

const { db } = require('../../../db');
const chatEvents = require('../../chat-events');

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
  await db.query(
    `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload)
     VALUES ($1,$2,'escalated','escalate_to_operator',$3)`,
    [salonId, dialogKey, JSON.stringify({ reason })]);
  // Диалог ждёт живого человека — подсветить его в списке чатов немедленно.
  chatEvents.emitAgentStatus(salonId, dialogKey, 'escalated', reason);
  return { escalated: true, reason };
}

module.exports = { schema, run };
