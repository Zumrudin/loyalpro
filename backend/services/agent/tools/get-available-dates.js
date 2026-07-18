'use strict';

const { db } = require('../../../db');
const { ycGetStaffSchedule } = require('../../yclients-booking');

// YYYY-MM-DD по Москве со сдвигом на N дней. Москва — фиксированный UTC+3, DST нет.
function moscowDatePlus(days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

const schema = {
  name: 'get_available_dates',
  description: 'График работы мастера: в какие дни и часы он работает (реальное расписание из YClients, ' +
    'не зависит от онлайн-записи). Отвечай по этому на вопросы «когда работает / какой график / ' +
    'в какие дни принимает мастер». По умолчанию — ближайшие 14 дней; можно указать date_from/date_to ' +
    '(YYYY-MM-DD). Сначала узнай yc_id мастера через list_staff. ' +
    'Для конкретного свободного времени на выбранную дату используй get_available_slots.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id: { type: 'integer', description: 'YClients-id мастера (из list_staff).' },
      date_from:   { type: 'string',  description: 'Начало периода YYYY-MM-DD. По умолчанию сегодня.' },
      date_to:     { type: 'string',  description: 'Конец периода YYYY-MM-DD. По умолчанию +14 дней.' },
    },
    required: ['staff_yc_id'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const staffId = input && input.staff_yc_id;
  if (!staffId) return { error: 'Нужен staff_yc_id (из list_staff).' };
  const from = (input && input.date_from) || moscowDatePlus(0);
  const to = (input && input.date_to) || moscowDatePlus(14);
  const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
  try {
    const rows = await ycGetStaffSchedule(salon, staffId, from, to);
    const schedule = (Array.isArray(rows) ? rows : [])
      .filter(r => r && r.is_working && Array.isArray(r.slots) && r.slots.length)
      .map(r => ({
        date: r.date,
        hours: r.slots.map(s => ({ from: s.from, to: s.to })),
      }));
    return { schedule, working_days_count: schedule.length };
  } catch (e) {
    return { error: `Не удалось получить график: ${e.message}` };
  }
}

module.exports = { schema, run };
