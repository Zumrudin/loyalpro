'use strict';

const { db } = require('../../../db');
const { ycGetBookTimes, ycGetStaffSeances } = require('../../yclients-booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const staffGuard = require('../staff-service-guard');
const eq = require('../equipment');
const eqContext = require('../equipment-context');
const leadTime = require('../lead-time');

const DEFAULT_STEP_MIN = 30;       // шаг предлагаемых стартов в fallback-режиме
const DEFAULT_DURATION_MIN = 60;   // если YClients не отдал duration услуги (как в get_parallel_slots)
const MAX_ALT_STAFF = 3;           // сколько других мастеров услуги проверяем при пустой выдаче

const schema = {
  name: 'get_available_slots',
  description: 'Свободное время у мастера на конкретную дату ПОД КОНКРЕТНУЮ УСЛУГУ. Если у салона ' +
    'включена онлайн-запись — отдаёт слоты под услугу. Иначе считает свободность из графика (старты ' +
    'шагом 30 мин, куда услуга влезает целиком). Сначала узнай yc_id мастера (list_staff) и услуги ' +
    '(каталог услуг). Дата в формате YYYY-MM-DD. Само расписание (в какие дни работает) — get_available_dates.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера (из list_staff).' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги (из каталога услуг).' },
      date:          { type: 'string',  description: 'Дата YYYY-MM-DD.' },
    },
    required: ['staff_yc_id', 'service_yc_id', 'date'],
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

// Отрезаем недопустимые старты: прошедшее время И слоты ближе минимального
// срока до визита (lead-time: день в день +2ч, вечером на завтра — с 12:00).
// Для сегодня floor = now+2ч сам по себе строже отсечки прошлого.
function dropDisallowedStarts(result, date, nowMs) {
  const now = moscowNow(nowMs);
  const cut = leadTime.minStartMin(now, date);
  if (!cut) return result;
  if (Array.isArray(result.slots)) {
    result.slots = result.slots.filter(s => toMin(s.time) >= cut);
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

// Слоты одного мастера под услугу на дату: сперва онлайн-запись (точные слоты),
// иначе fallback из графика с вычетом занятого оборудования. Вынесено из run(),
// чтобы тем же кодом считать альтернативных мастеров при пустой выдаче.
async function computeStaffSlots(salon, staffId, serviceId, date, nowMs) {
  // 1) Онлайн-запись включена и известна услуга → точные слоты под услугу.
  if (serviceId) {
    const times = await ycGetBookTimes(salon, staffId, date, [serviceId]);
    const slots = (Array.isArray(times) ? times : []).map(t => ({
      time: t.time, datetime: t.datetime, seance_length: t.seance_length,
    }));
    if (slots.length) return dropDisallowedStarts({ slots, source: 'booking' }, date, nowMs);
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
  // Отдаём модели ТОЛЬКО slots — детерминированные старты, куда услуга влезает
  // целиком. Раньше рядом возвращались free_ranges («сырые» окна кресла до
  // фильтра длительности, «для ответа пациенту»), но слабая модель цитировала и
  // округляла их границы как время записи: инцидент 2026-07-28 — окно с 14:40
  // названо пациенту «14:00», create_booking упал «время недоступно» → ложная
  // эскалация. Единственный допустимый источник предлагаемого времени — slots.
  let slots = rangesToSlots(ranges, date, DEFAULT_STEP_MIN, svcDurationMin);
  // seance_length — как у get_parallel_slots: create_booking без него ловил 422
  // на салонах с выключенной онлайн-записью.
  if (svcDurationMin) {
    slots = slots.map(s => ({ ...s, seance_length: svcDurationMin * 60 }));
  }
  const out = { slots, source: 'schedule' };
  if (equipmentBusy) out.equipment_busy = true;   // часть окон срезана занятым аппаратом
  return dropDisallowedStarts(out, date, nowMs);
}

// У запрошенного мастера пусто → проверяем других исполнителей ЭТОЙ услуги на ту же
// дату. Инцидент 2026-08-01: «Голливуд» на завтра — модель проверила только Юлию и
// сказала «окошек нет», хотя у Татьяны было 14:00; клиент сам вытащил альтернативу
// вопросом «а почему к Тане не предлагаешь?». Задача — довести до записи: альтернативу
// подсвечивает сам инструмент, а не память модели.
async function findAlternativeStaff(salon, filter, staffList, staffId, serviceId, date, nowMs) {
  const others = (staffList || [])
    .filter(m => m && m.yc_id && String(m.yc_id) !== String(staffId))
    .filter(m => svcFilter.isBookable(filter, serviceId, m.yc_id))
    .slice(0, MAX_ALT_STAFF);
  if (!others.length) return null;
  const checked = await Promise.all(others.map(async (m) => {
    try {
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs);
      return { staff_yc_id: m.yc_id, name: m.name, slots: r.slots || [] };
    } catch (_) { return null; }   // сбой по одному мастеру не валит весь ответ
  }));
  const reachable = checked.filter(Boolean);
  const withSlots = reachable.filter(a => a.slots.length);
  if (withSlots.length) return { alternative_staff: withSlots };
  // Все альтернативы реально проверены и пусты → модель может честно сказать,
  // что на эту дату времени нет ни у кого из исполнителей услуги.
  if (reachable.length === others.length) return { no_alternative_staff: true };
  return null;
}

async function run(salonId, input, ctx = {}) {
  const serviceId = input && input.service_yc_id;
  const staffId = input && input.staff_yc_id;
  const date = input && input.date;
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  if (!staffId || !date) return { error: 'Нужны staff_yc_id и date (YYYY-MM-DD).' };
  // Услуга обязательна: без неё неизвестна длительность, и старты считались бы
  // «хотя бы на один шаг» — сеткой 30 мин. Инцидент 2026-07-31: так предложили
  // 11:30 перед чужой записью в 12:00, а записывали 60-минутную процедуру →
  // YClients отказал «время недоступно» уже ПОСЛЕ согласования с пациентом.
  if (!serviceId) {
    return { error: 'Нужен service_yc_id: без услуги нельзя проверить, влезает ли процедура в окно. ' +
      'Возьми точный id услуги из каталога услуг. Если вопрос про график мастера (в какие дни ' +
      'работает) — это get_available_dates, а не слоты.' };
  }
  // Скрытую услугу/пару не предлагаем (мягкий пустой ответ, без «технических сложностей»).
  let filter = {};
  let staffList = [];
  if (serviceId) {
    filter = await settings.loadServiceFilterSafe(salonId);
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
        : 'Подбери мастера из поля staff нужной услуги в каталоге услуг.';
      return {
        slots: [], staff_mismatch: true,
        error: `Выбранный мастер не выполняет эту услугу — НЕ предлагай его время и не подтверждай запись к нему. ${who}`,
      };
    }
    staffList = chk.staffList || [];
  }
  const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
  try {
    const out = await computeStaffSlots(salon, staffId, serviceId, date, nowMs);
    if (out.slots.length) return out;
    // У запрошенного мастера на эту дату пусто → сразу подсвечиваем альтернативу:
    // те же слоты у других исполнителей услуги, чтобы клиент не ушёл без записи.
    const alt = await findAlternativeStaff(salon, filter, staffList, staffId, serviceId, date, nowMs);
    if (alt && alt.alternative_staff) {
      out.alternative_staff = alt.alternative_staff;
      out.hint = 'У выбранного мастера на эту дату свободного времени нет, но ЭТУ ЖЕ услугу в этот день ' +
        'выполняют другие мастера — их реальные свободные окна в alternative_staff. Предложи пациенту ' +
        'записаться к одному из них (назови имя), время бери ДОСЛОВНО из их slots. ' +
        // Инцидент 2026-08-04: пациент про мастера не спрашивал, мастера для проверки
        // выбрала сама модель — и пациент получил «у главного врача Пери Исамудиновны
        // на завтра всё занято». Кого проверяли внутри, пациента не касается.
        'Если пациент этого мастера сам не спрашивал (выбрала его ты) — НЕ говори, что у него занято: ' +
        'просто предложи специалиста с окнами и его время, без отчёта о проверке.';
    } else if (alt && alt.no_alternative_staff) {
      out.no_alternative_staff = true;   // проверены ВСЕ исполнители услуги — на дату пусто у всех
    }
    return out;
  } catch (e) {
    return { error: `Не удалось получить слоты: ${e.message}` };
  }
}

module.exports = { schema, run, seancesToRanges, rangesToSlots, toMin, toHHMM };
