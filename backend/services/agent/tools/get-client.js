'use strict';

const { db } = require('../../../db');
const { normalizePhoneKey } = require('../../agent-gate');

const schema = {
  name: 'get_client',
  description: 'Найти клиента салона по номеру телефона (имя, id). ' +
    'Использовать, чтобы обратиться по имени и подставить телефон в запись.',
  input_schema: {
    type: 'object',
    properties: { phone: { type: 'string', description: 'Телефон клиента.' } },
    required: ['phone'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const phone = normalizePhoneKey(String((input && input.phone) || ''));
  if (!phone) return { found: false };
  const row = await db.oneOrNone(
    `SELECT id, name, phone FROM clients
      WHERE salon_id = $1 AND phone LIKE '%' || $2
      LIMIT 1`,
    [salonId, phone]);
  if (!row) return { found: false };
  return { found: true, client: { id: row.id, name: row.name, phone: row.phone } };
}

module.exports = { schema, run };
