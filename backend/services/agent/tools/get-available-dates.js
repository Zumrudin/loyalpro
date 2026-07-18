'use strict';

const { db } = require('../../../db');
const { ycGetBookDates } = require('../../yclients-booking');

const schema = {
  name: 'get_available_dates',
  description: 'Даты, в которые у мастера есть свободная запись (на ближайший период) под услугу(и). ' +
    'Отвечает на вопросы «когда работает / в какие дни доступен мастер». ' +
    'Сначала узнай yc_id мастера (list_staff) и, если возможно, услуги (list_services). ' +
    'Для конкретного свободного времени на выбранную дату используй get_available_slots.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера (из list_staff).' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги (из list_services). Необязательно, но уточняет доступность.' },
    },
    required: ['staff_yc_id'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const staffId = input && input.staff_yc_id;
  const serviceId = input && input.service_yc_id;
  if (!staffId) return { error: 'Нужен staff_yc_id (из list_staff).' };
  const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
  try {
    const serviceIds = serviceId ? [serviceId] : [];
    const res = await ycGetBookDates(salon, staffId, serviceIds);
    const dates = res && Array.isArray(res.booking_dates) ? res.booking_dates : [];
    return { dates };
  } catch (e) {
    return { error: `Не удалось получить даты записи: ${e.message}` };
  }
}

module.exports = { schema, run };
