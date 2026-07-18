'use strict';

const { db } = require('../../../db');
const { ycGetBookDates } = require('../../yclients-booking');

const schema = {
  name: 'get_available_dates',
  description: 'График работы мастера и дни, в которые у него есть свободная запись. ' +
    'Возвращает schedule_dates — рабочие дни мастера (его график) — и bookable_dates — ' +
    'дни, где ещё есть свободные окошки. На вопрос «когда работает / какой график у мастера» ' +
    'отвечай по schedule_dates; на «когда можно записаться» — по bookable_dates. ' +
    'Если bookable_dates пуст, но schedule_dates нет — мастер работает, но свободных окон нет ' +
    '(предложи другой день/мастера или эскалацию). Сначала узнай yc_id мастера (list_staff); ' +
    'service_yc_id (list_services) уточняет свободные окошки.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера (из list_staff).' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги (из list_services). Необязательно, но уточняет свободные окошки.' },
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
    const scheduleDates = res && Array.isArray(res.working_dates) ? res.working_dates : [];
    const bookableDates = res && Array.isArray(res.booking_dates) ? res.booking_dates : [];
    return { schedule_dates: scheduleDates, bookable_dates: bookableDates };
  } catch (e) {
    return { error: `Не удалось получить даты записи: ${e.message}` };
  }
}

module.exports = { schema, run };
