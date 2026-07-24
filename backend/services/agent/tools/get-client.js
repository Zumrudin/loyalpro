'use strict';

const { db } = require('../../../db');
const { normalizePhoneKey } = require('../../agent-gate');

const schema = {
  name: 'get_client',
  description: 'Проверить по номеру телефона, есть ли карта клиента в клинике. ' +
    'Имя и данные карты возвращаются ТОЛЬКО для номера самого собеседника ' +
    '(подтверждённого каналом); по любым другим номерам — только факт наличия карты, ' +
    'без личных данных. НЕ использовать, чтобы узнать имя владельца чужого номера.',
  input_schema: {
    type: 'object',
    properties: { phone: { type: 'string', description: 'Телефон клиента.' } },
    required: ['phone'],
    additionalProperties: false,
  },
};

async function run(salonId, input, ctx = {}) {
  const phone = normalizePhoneKey(String((input && input.phone) || ''));
  // Короткий ключ в суффиксном LIKE совпал бы с хвостом чужого номера —
  // ищем только по полному номеру (10+ цифр).
  if (!phone || phone.length < 10) return { found: false };
  const row = await db.oneOrNone(
    `SELECT id, name, phone FROM clients
      WHERE salon_id = $1 AND phone LIKE '%' || $2
      LIMIT 1`,
    [salonId, phone]);
  if (!row) return { found: false };
  // PII-гейт: имя и телефон из карточки отдаём модели только когда запрошен номер
  // самого собеседника (ctx.clientPhone пришёл из вебхука канала). Иначе собеседник
  // мог бы «пробить» произвольный номер и узнать имя чужого клиента.
  const own = ctx && ctx.clientPhone
    && normalizePhoneKey(String(ctx.clientPhone)) === phone;
  if (!own) return { found: true };
  return { found: true, client: { id: row.id, name: row.name, phone: row.phone } };
}

module.exports = { schema, run };
