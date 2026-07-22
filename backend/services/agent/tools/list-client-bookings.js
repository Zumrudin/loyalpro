'use strict';

const { db } = require('../../../db');
const identity = require('../identity');
const { ycGetClientRecords } = require('../../yclients-records');

const schema = {
  name: 'list_client_bookings',
  description: 'Показать БУДУЩИЕ записи текущего пациента — для отмены или переноса. ' +
    'Телефон берётся из системы автоматически, аргументы не нужны. Возвращает список ' +
    'записей: record_id, дата/время, услуга(и), мастер. record_id из этого списка ' +
    'передавай в cancel_booking / reschedule_booking — НИКОГДА не придумывай его.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

// YYYY-MM-DD по Москве — нижняя граница живого запроса записей.
function moscowDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(ms));
}

async function run(salonId, _input, ctx = {}) {
  const phone = String((ctx && ctx.clientPhone) || '').trim();
  if (!phone) {
    return { bookings: [], reason: 'no_phone',
      note: 'Телефон пациента неизвестен — вежливо попроси номер, чтобы найти его записи.' };
  }
  const ycClientId = await identity.resolveYclientsClientId(salonId, phone);
  if (!ycClientId) {
    return { bookings: [], reason: 'client_not_found',
      note: 'Активных записей у пациента не найдено — предложи создать новую запись.' };
  }
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon.yclients_company_id) return { bookings: [], reason: 'no_yclients' };

  const nowMs = (ctx && ctx.nowMs) || Date.now();
  let recs;
  try { recs = await ycGetClientRecords(salon, ycClientId, { startDate: moscowDate(nowMs) }); }
  catch (e) { return { bookings: [], error: `Не удалось получить записи: ${e.message}` }; }

  const bookings = recs
    .filter(r => Number(r.attendance) !== -1 && !r.deleted)
    .filter(r => {
      const t = Date.parse(r.datetime || r.date || '');
      return !Number.isFinite(t) || t >= nowMs;   // прошлое отбрасываем
    })
    .map(r => ({
      record_id: r.id,
      datetime: r.datetime || r.date || null,
      services: (Array.isArray(r.services) ? r.services : []).map(s => s.title).filter(Boolean),
      staff_yc_id: r.staff_id || (r.staff && r.staff.id) || null,
      staff_name: (r.staff && r.staff.name) || null,
    }));
  return { bookings };
}

module.exports = { schema, run };
