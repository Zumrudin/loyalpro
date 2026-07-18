'use strict';

const { db } = require('../../../db');
const { ycGetBookTimes } = require('../../yclients-booking');

const schema = {
  name: 'get_available_slots',
  description: 'Свободные слоты у конкретного мастера под конкретную услугу на дату. ' +
    'Сначала узнай yc_id услуги (list_services) и мастера (list_staff). Дата в формате YYYY-MM-DD.',
  input_schema: {
    type: 'object',
    properties: {
      service_yc_id: { type: 'integer', description: 'YClients-id услуги (из list_services).' },
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера (из list_staff).' },
      date:          { type: 'string',  description: 'Дата YYYY-MM-DD.' },
    },
    required: ['service_yc_id', 'staff_yc_id', 'date'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const serviceId = input && input.service_yc_id;
  const staffId = input && input.staff_yc_id;
  const date = input && input.date;
  if (!serviceId || !staffId || !date) {
    return { error: 'Нужны service_yc_id, staff_yc_id и date (YYYY-MM-DD).' };
  }
  const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
  try {
    const times = await ycGetBookTimes(salon, staffId, date, [serviceId]);
    const slots = (Array.isArray(times) ? times : []).map(t => ({
      time: t.time, datetime: t.datetime, seance_length: t.seance_length,
    }));
    return { slots };
  } catch (e) {
    return { error: `Не удалось получить слоты: ${e.message}` };
  }
}

module.exports = { schema, run };
