'use strict';

const { db } = require('../../../db');
const { ycGetBookTimes, ycGetStaffSeances } = require('../../yclients-booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');

const DEFAULT_STEP_MIN = 30;   // шаг предлагаемых стартов в fallback-режиме

const schema = {
  name: 'get_available_slots',
  description: 'Свободное время у мастера на конкретную дату. Если у салона включена онлайн-запись — ' +
    'отдаёт слоты под услугу (нужен service_yc_id из list_services). Иначе считает свободность из ' +
    'графика (окна раздвигаются шагом 30 мин). Сначала узнай yc_id мастера (list_staff) и, если есть, ' +
    'услуги (list_services). Дата в формате YYYY-MM-DD. Само расписание (в какие дни работает) — get_available_dates.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера (из list_staff).' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги (из list_services). Нужен для салонов с онлайн-записью.' },
      date:          { type: 'string',  description: 'Дата YYYY-MM-DD.' },
    },
    required: ['staff_yc_id', 'date'],
    additionalProperties: false,
  },
};

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// 5-мин грид is_free → непрерывные интервалы [{from,to}] (to эксклюзивно, +5 мин к последней точке).
function seancesToRanges(seances) {
  const free = (Array.isArray(seances) ? seances : [])
    .filter(s => s && s.is_free)
    .map(s => toMin(s.time))
    .sort((a, b) => a - b);
  const ranges = [];
  for (const m of free) {
    const last = ranges[ranges.length - 1];
    if (last && m === last.end) { last.end = m + 5; }
    else { ranges.push({ start: m, end: m + 5 }); }
  }
  return ranges;
}

// Из интервалов — старты с шагом step, где влезает хотя бы один шаг свободного времени.
function rangesToSlots(ranges, date, step) {
  const slots = [];
  for (const r of ranges) {
    for (let t = r.start; t + step <= r.end; t += step) {
      const hhmm = toHHMM(t);
      slots.push({ time: hhmm, datetime: `${date}T${hhmm}:00+03:00` });
    }
  }
  return slots;
}

async function run(salonId, input) {
  const serviceId = input && input.service_yc_id;
  const staffId = input && input.staff_yc_id;
  const date = input && input.date;
  if (!staffId || !date) return { error: 'Нужны staff_yc_id и date (YYYY-MM-DD).' };
  // Скрытую услугу/пару не предлагаем (мягкий пустой ответ, без «технических сложностей»).
  if (serviceId) {
    const filter = await settings.loadServiceFilterSafe(salonId);
    if (!svcFilter.isBookable(filter, serviceId, staffId)) {
      return { slots: [], filtered: true };
    }
  }
  const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
  try {
    // 1) Онлайн-запись включена и известна услуга → точные слоты под услугу.
    if (serviceId) {
      const times = await ycGetBookTimes(salon, staffId, date, [serviceId]);
      const slots = (Array.isArray(times) ? times : []).map(t => ({
        time: t.time, datetime: t.datetime, seance_length: t.seance_length,
      }));
      if (slots.length) return { slots, source: 'booking' };
    }
    // 2) Иначе (или пусто) — свободность из графика (management API, без онлайн-записи).
    const seances = await ycGetStaffSeances(salon, staffId, date);
    const ranges = seancesToRanges(seances);
    const freeRanges = ranges.map(r => ({ from: toHHMM(r.start), to: toHHMM(r.end) }));
    const slots = rangesToSlots(ranges, date, DEFAULT_STEP_MIN);
    return { slots, free_ranges: freeRanges, source: 'schedule' };
  } catch (e) {
    return { error: `Не удалось получить слоты: ${e.message}` };
  }
}

module.exports = { schema, run };
