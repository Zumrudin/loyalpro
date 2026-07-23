'use strict';

const { db } = require('../../../db');
const { ycGetBookTimes, ycGetStaffSeances } = require('../../yclients-booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const staffGuard = require('../staff-service-guard');
const eq = require('../equipment');
const eqContext = require('../equipment-context');

const DEFAULT_STEP_MIN = 30;       // шаг предлагаемых стартов в fallback-режиме
const DEFAULT_DURATION_MIN = 60;   // если YClients не отдал duration услуги (как в get_parallel_slots)

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

// Текущий момент по Москве: { date:'YYYY-MM-DD', minutes: часы*60+минуты }.
function moscowNow(ms) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const [h, m] = hm.split(':').map(Number);
  return { date, minutes: h * 60 + m };
}

// Отрезаем уже прошедшее время, если дата — сегодня по Москве. Иначе не трогаем.
// Нельзя предлагать пациенту окно, которое наступит в прошлом.
function dropPastToday(result, date, nowMs) {
  const now = moscowNow(nowMs);
  if (date !== now.date) return result;
  const cut = now.minutes;
  if (Array.isArray(result.slots)) {
    result.slots = result.slots.filter(s => toMin(s.time) > cut);
  }
  if (Array.isArray(result.free_ranges)) {
    result.free_ranges = result.free_ranges
      .map(r => ({ from: toMin(r.from) < cut ? toHHMM(cut) : r.from, to: r.to }))
      .filter(r => toMin(r.from) < toMin(r.to) && toMin(r.to) > cut);
  }
  return result;
}

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

// Из интервалов — старты с шагом step, куда услуга влезает ЦЕЛИКОМ (durationMin);
// если длительность неизвестна (0/не передана) — по-прежнему хотя бы один шаг.
// Старт привязываем к ЧИСТОЙ сетке (кратной step от полуночи → :00/:30), а НЕ к
// r.start. Иначе окно, начатое в 19:05 (хвост от предыдущей записи чужой длительности),
// тянуло смещение через все старты: 19:05, 19:35, 20:05 — и прятало свободные 19:00/20:00.
function rangesToSlots(ranges, date, step, durationMin) {
  const need = durationMin > 0 ? durationMin : step;
  const slots = [];
  for (const r of ranges) {
    const first = Math.ceil(r.start / step) * step;   // ближайший чистый старт ≥ r.start
    for (let t = first; t + need <= r.end; t += step) {
      const hhmm = toHHMM(t);
      slots.push({ time: hhmm, datetime: `${date}T${hhmm}:00+03:00` });
    }
  }
  return slots;
}

async function run(salonId, input, ctx = {}) {
  const serviceId = input && input.service_yc_id;
  const staffId = input && input.staff_yc_id;
  const date = input && input.date;
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  if (!staffId || !date) return { error: 'Нужны staff_yc_id и date (YYYY-MM-DD).' };
  // Скрытую услугу/пару не предлагаем (мягкий пустой ответ, без «технических сложностей»).
  if (serviceId) {
    const filter = await settings.loadServiceFilterSafe(salonId);
    if (!svcFilter.isBookable(filter, serviceId, staffId)) {
      return { slots: [], filtered: true };
    }
    // Предпроверка: выбранный мастер должен реально выполнять услугу. График/кресло
    // мастера слепы к этому — без проверки предложим окна того, кто процедуру не
    // делает (клиент назвал мастера по имени → его yc_id пришёл из list_staff).
    const chk = await staffGuard.checkStaffPerformsService(salonId, serviceId, staffId);
    if (!chk.unknown && !chk.ok) {
      const who = chk.performers.length
        ? `Эту услугу выполняют: ${chk.performers.join(', ')}. Предложи пациенту одного из них.`
        : 'Подбери мастера из поля staff нужной услуги в list_services.';
      return {
        slots: [], staff_mismatch: true,
        error: `Выбранный мастер не выполняет эту услугу — НЕ предлагай его время и не подтверждай запись к нему. ${who}`,
      };
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
      if (slots.length) return dropPastToday({ slots, source: 'booking' }, date, nowMs);
    }
    // 2) Иначе (или пусто) — свободность из графика (management API, без онлайн-записи).
    // Этот график знает только занятость кресла мастера и слеп к аппаратам,
    // поэтому вычитаем время, когда занято оборудование услуги: иначе предложим
    // окно, на котором создание записи упрётся в save_if_busy:false.
    const seances = await ycGetStaffSeances(salon, staffId, date);
    let ranges = seancesToRanges(seances);
    let equipmentBusy = false;
    // Длительность услуги: старт годится, только если услуга влезает целиком до
    // конца окна мастера (как в get_parallel_slots). Без service_yc_id длительность
    // знать неоткуда — остаётся прежняя проверка «хотя бы один шаг».
    let svcDurationMin = 0;
    if (serviceId) {
      const eqCtx = await eqContext.loadEquipmentContext(salon, date);
      svcDurationMin = eqContext.durationMin(eqCtx, serviceId) || DEFAULT_DURATION_MIN;
      const busy = eqContext.busyForService(eqCtx, serviceId);
      if (busy.length) {
        const trimmed = eq.subtractRanges(ranges, busy);
        equipmentBusy = trimmed.length !== ranges.length
          || trimmed.some((r, i) => !ranges[i] || r.start !== ranges[i].start || r.end !== ranges[i].end);
        ranges = trimmed;
      }
    }
    // free_ranges — «сырые» окна кресла для ответа пациенту (до фильтра длительности),
    // slots — старты с гарантией, что услуга помещается целиком.
    const freeRanges = ranges.map(r => ({ from: toHHMM(r.start), to: toHHMM(r.end) }));
    let slots = rangesToSlots(ranges, date, DEFAULT_STEP_MIN, svcDurationMin);
    // seance_length — как у get_parallel_slots: create_booking без него ловил 422
    // на салонах с выключенной онлайн-записью.
    if (svcDurationMin) {
      slots = slots.map(s => ({ ...s, seance_length: svcDurationMin * 60 }));
    }
    const out = { slots, free_ranges: freeRanges, source: 'schedule' };
    if (equipmentBusy) out.equipment_busy = true;   // часть окон срезана занятым аппаратом
    return dropPastToday(out, date, nowMs);
  } catch (e) {
    return { error: `Не удалось получить слоты: ${e.message}` };
  }
}

module.exports = { schema, run, seancesToRanges, rangesToSlots, toMin, toHHMM };
