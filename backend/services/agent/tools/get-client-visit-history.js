'use strict';

const { db } = require('../../../db');
const identity = require('../identity');
const { ycGetClientRecords } = require('../../yclients-records');

const schema = {
  name: 'get_client_visit_history',
  description: 'Показать ПРОШЛЫЕ (уже состоявшиеся) визиты текущего пациента — какие ' +
    'услуги он делал раньше. Помогает понять, что человек имеет в виду под бытовым/' +
    'сокращённым словом (напр. «лазер»), и подобрать нужную услугу. Телефон берётся ' +
    'из системы автоматически, аргументы не нужны. Возвращает список визитов: дата/' +
    'время, услуга(и), мастер. Зови ТОЛЬКО при реальной неоднозначности и только для ' +
    'идентифицированного пациента — лишний вызов приближает ход к лимиту инструментов.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

// YYYY-MM-DD по Москве — верхняя граница живого запроса записей (по сегодня включительно).
function moscowDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(ms));
}

const MAX_VISITS = 10;

async function run(salonId, _input, ctx = {}) {
  const phone = String((ctx && ctx.clientPhone) || '').trim();
  if (!phone) {
    return { visits: [], reason: 'no_phone',
      note: 'Телефон пациента неизвестен — историю визитов посмотреть нельзя.' };
  }
  const ycClientId = await identity.resolveYclientsClientId(salonId, phone);
  if (!ycClientId) {
    return { visits: [], reason: 'client_not_found',
      note: 'Прошлых визитов у пациента не найдено — вероятно, он обращается впервые.' };
  }
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon.yclients_company_id) return { visits: [], reason: 'no_yclients' };

  const nowMs = (ctx && ctx.nowMs) || Date.now();
  let recs;
  try { recs = await ycGetClientRecords(salon, ycClientId, { endDate: moscowDate(nowMs) }); }
  catch (e) { return { visits: [], error: `Не удалось получить историю визитов: ${e.message}` }; }

  const visits = recs
    .filter(r => Number(r.attendance) !== -1 && !r.deleted)   // не «клиент не пришёл» и не удалённые
    .filter(r => {
      const t = Date.parse(r.datetime || r.date || '');
      return Number.isFinite(t) && t < nowMs;                  // только прошлое
    })
    .sort((a, b) => Date.parse(b.datetime || b.date || '') - Date.parse(a.datetime || a.date || ''))
    .slice(0, MAX_VISITS)
    .map(r => ({
      datetime: r.datetime || r.date || null,
      services: (Array.isArray(r.services) ? r.services : []).map(s => s.title).filter(Boolean),
      staff_name: (r.staff && r.staff.name) || null,
    }));
  return { visits };
}

module.exports = { schema, run };
