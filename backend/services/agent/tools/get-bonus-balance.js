'use strict';

const { db } = require('../../../db');
const identity = require('../identity');
const { normalizePhoneKey } = require('../../agent-gate');
const { ycGetClientCards } = require('../../yclients');

const schema = {
  name: 'get_bonus_balance',
  description: 'Текущий баланс бонусной карты пациента (карта лояльности в YClients). ' +
    'Телефон берётся из системы автоматически — данные ТОЛЬКО самого собеседника, ' +
    'аргументы не нужны. Возвращает карты: программа, номер, баланс в бонусах. ' +
    'Зови, когда пациент спрашивает свой баланс/бонусы. Данные живые — не отвечай по памяти.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input, ctx = {}) {
  // Телефон — только подтверждённый каналом номер собеседника (ctx.clientPhone).
  // Аргументов у инструмента нет намеренно: «пробить» чужой номер невозможно.
  const phone = normalizePhoneKey(String((ctx && ctx.clientPhone) || ''));
  if (!phone || phone.length < 10) {
    return { found: false, reason: 'no_phone',
      note: 'Номер пациента системе неизвестен — баланс сообщить нельзя.' };
  }
  // yclients_client_id уже лежит в карточке клиента (loyalty-синк);
  // резолв по records — запасной путь.
  const row = await db.oneOrNone(
    `SELECT yclients_client_id FROM clients
      WHERE salon_id = $1 AND phone LIKE '%' || $2
        AND yclients_client_id IS NOT NULL
      LIMIT 1`, [salonId, phone]);
  let ycClientId = row && row.yclients_client_id ? Number(row.yclients_client_id) : null;
  if (!ycClientId) ycClientId = await identity.resolveYclientsClientId(salonId, phone);
  if (!ycClientId) {
    return { found: false, reason: 'client_not_found',
      note: 'Карта пациента в системе не найдена.' };
  }
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon.yclients_company_id) return { found: false, reason: 'no_yclients' };

  const cards = await ycGetClientCards(salon, ycClientId); // при ошибке YClients → []
  if (!Array.isArray(cards) || cards.length === 0) {
    return { found: false, reason: 'no_card',
      note: 'Бонусная карта не найдена — предложи уточнить у администратора.' };
  }
  return { found: true, cards: cards.map(c => ({
    program: (c.type && c.type.title) || null,
    number: c.number || null,
    balance: Number(c.balance) || 0,
  })) };
}

module.exports = { schema, run };
