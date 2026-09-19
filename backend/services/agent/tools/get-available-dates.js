'use strict';

const { db } = require('../../../db');
const { ycGetStaffSchedule } = require('../../yclients-booking');
const staffSchedule = require('../staff-schedule');

// Минимум дней от `from`, которые тул проверяет В ЗАПРОСЕ К YCLIENTS ВСЕГДА —
// даже когда модель сама сузила date_from/date_to до одного дня. Иначе узкий
// запрос («работает ли во вторник?») на выходной отвечает пустотой, а следующий
// день Мила выясняет вслепую перебором по одному — вместо того чтобы получить
// ближайший рабочий день сразу этим же вызовом.
const FLOOR_DAYS = 14;

// YYYY-MM-DD по Москве со сдвигом на N дней. Москва — фиксированный UTC+3, DST нет.
function moscowDatePlus(days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}
// Тот же сдвиг, но от ПРОИЗВОЛЬНОЙ даты (не от «сегодня») — считает пол окна от запрошенного date_from.
function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
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
  const floorTo = addDaysStr(from, FLOOR_DAYS);
  const queryTo = to > floorTo ? to : floorTo;  // сам запрос к YClients — не уже пола, даже если модель попросила один день
  const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
  try {
    const rows = await ycGetStaffSchedule(salon, staffId, from, queryTo);
    const allRows = Array.isArray(rows) ? rows : [];
    const schedule = allRows
      .filter(r => r && r.is_working && Array.isArray(r.slots) && r.slots.length && r.date <= to)
      .map(r => ({
        date: r.date,
        hours: r.slots.map(s => ({ from: s.from, to: s.to })),
      }));
    const result = { schedule, working_days_count: schedule.length };
    // Запрошенный (возможно узкий) период целиком пуст — используем уже проверенный
    // ЗАПАС (queryTo ≥ floorTo) и называем реальный ближайший рабочий день сразу,
    // вместо того чтобы Мила гадала по одному дню за раз следующими вызовами.
    if (!schedule.length) {
      const sched = staffSchedule.summarizeWorkingDays(allRows, { date: from });
      if (!sched.unknown) {
        result.next_working_date = sched.nextWorkingDate || null;
        if (!sched.nextWorkingDate) result.schedule_checked_until = sched.checkedUntil;
        result.hint = sched.nextWorkingDate
          ? `В запрошенном периоде (${from}${to !== from ? `–${to}` : ''}) у мастера рабочих дней нет. ` +
            `Не предлагай пациенту непроверенные дни по одной догадке — график уже проверен дальше, и ближайший ` +
            `реальный рабочий день известен: ${sched.nextWorkingDate}. Называй его сразу (часы на него запроси отдельным вызовом).`
          : `В запрошенном периоде и до ${sched.checkedUntil} у мастера рабочих дней нет вовсе. ` +
            'Не перебирай даты вслепую — честно скажи пациенту, что рабочих дней в проверенном периоде не нашлось, ' +
            'и предложи другого специалиста или связь с администратором.';
      }
    }
    return result;
  } catch (e) {
    return { error: `Не удалось получить график: ${e.message}` };
  }
}

module.exports = { schema, run };
