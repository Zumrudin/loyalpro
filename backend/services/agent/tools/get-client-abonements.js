'use strict';

const { db } = require('../../../db');
const { normalizePhoneKey } = require('../../agent-gate');
const { ycGetClientAbonements } = require('../../yclients');

const MAX_ABONEMENTS = 10;

const schema = {
  name: 'get_client_abonements',
  description: 'Активные абонементы пациента из YClients: название, остаток посещений, ' +
    'срок действия, статус (заморожен/не активирован). Телефон берётся из системы ' +
    'автоматически — данные ТОЛЬКО самого собеседника, аргументы не нужны. Зови, когда ' +
    'пациент спрашивает про свой абонемент или сколько посещений осталось. ' +
    'Данные живые — не отвечай по памяти.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input, ctx = {}) {
  // Телефон — только подтверждённый каналом номер собеседника (см. get-bonus-balance).
  const phone = normalizePhoneKey(String((ctx && ctx.clientPhone) || ''));
  if (!phone || phone.length < 10) {
    return { abonements: [], reason: 'no_phone',
      note: 'Номер пациента системе неизвестен — абонементы посмотреть нельзя.' };
  }
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon.yclients_company_id) return { abonements: [], reason: 'no_yclients' };

  let list;
  try { list = await ycGetClientAbonements(salon, phone); }
  catch (e) { return { abonements: [], error: `Не удалось получить абонементы: ${e.message}` }; }

  const nowMs = (ctx && ctx.nowMs) || Date.now();
  const abonements = (Array.isArray(list) ? list : [])
    .map(a => {
      const links = (a.balance_container && Array.isArray(a.balance_container.links))
        ? a.balance_container.links : [];
      const unlimited = !!a.is_united_balance_unlimited;
      // Единый баланс: остаток в united_balance_services_count (links[].count — нули).
      // Раздельный: остаток — сумма links[].count.
      const visitsLeft = a.is_united_balance
        ? (unlimited ? null : Number(a.united_balance_services_count) || 0)
        : links.reduce((s, l) => s + (Number(l.count) || 0), 0);
      return {
        title: (a.type && a.type.title) || a.balance_string || 'Абонемент',
        status: (a.status && (a.status.extended_title || a.status.title)) || null,
        is_frozen: !!a.is_frozen,
        expires: a.expiration_date || null, // null у неактивированных («Выпущен»)
        visits_left: unlimited ? 'безлимит' : visitsLeft,
        services: links.map(l =>
          (l.service && l.service.title) || (l.category && l.category.title)).filter(Boolean),
      };
    })
    .filter(x => x.visits_left === 'безлимит' || x.visits_left > 0)
    .filter(x => !x.expires || Date.parse(x.expires) >= nowMs)
    .slice(0, MAX_ABONEMENTS);

  if (!abonements.length) {
    return { abonements: [], note: 'Активных абонементов не найдено.' };
  }
  return { abonements };
}

module.exports = { schema, run };
