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
// Столько исполнителей проверяем, когда мастера выбирает пациент. Кап тот же, что у
// альтернатив: каждый мастер — отдельный запрос в YClients. Следствие — там, где
// исполнителей больше, часть в выдачу не попадёт, поэтому хинт запрещает модели
// утверждать «это все специалисты».
const MAX_STAFF_OPTIONS = 3;

const HINT_STAFF_CHOICE = 'Пациент специалиста не называл — выбор за НИМ, а не за тобой. ' +
  'Перечисли в ОДНОМ сообщении ВСЕХ из staff_options: имя, должность (position) и 1–2 времени ' +
  'ДОСЛОВНО из его slots, и спроси, к кому удобнее записать. НЕ выбирай сама и никого не советуй ' +
  'как «лучшего». Цену не называй, пока пациент сам о ней не спросил. НЕ утверждай, что это все ' +
  'специалисты клиники: здесь только те, у кого в этот день есть свободное время.';

// Выбор из одного варианта — не выбор, а лишний вопрос в переписке: «к кому вам
// удобнее?» при единственном мастере звучит нелепо и добавляет ход до записи.
const HINT_STAFF_SINGLE = 'Эту услугу в этот день ведёт один специалист — выбора не устраивай: ' +
  'назови его имя, должность (position) и 1–2 времени ДОСЛОВНО из slots и предложи записать.';

// Пустой staff_options с хинтом «перечисли ВСЕХ» — это указание перечислить пустоту:
// модель либо молчит, либо выдумывает мастера. Пустой день обязан звучать как пустой день.
const HINT_NO_STAFF = 'На эту дату свободного времени нет ни у одного исполнителя услуги — ' +
  'честно скажи об этом и предложи другой день (get_available_slots на другую дату).';

// Часть исполнителей проверить не удалось: про них мы не знаем НИЧЕГО, поэтому «нет
// ни у кого» — уже выдумка. Но и молчать не о чем: у проверенных действительно пусто,
// и предложить другую дату честно.
const HINT_STAFF_PARTIAL = 'У проверенных исполнителей на эту дату свободного времени нет, ' +
  'но часть специалистов проверить не удалось (временный сбой). НЕ утверждай, что времени нет ' +
  'ни у кого — этого мы не знаем. Предложи посмотреть другую дату (get_available_slots на другую дату).';

// Ни один исполнитель не ответил — это техническая неудача, а не занятость клиники.
// Тон и формулировка — как в одномастерной ветке («Не удалось получить слоты: …»).
const ERR_STAFF_UNREACHABLE = 'Не удалось получить слоты: ни один исполнитель услуги не ответил ' +
  '(временный сбой). НЕ говори пациенту, что свободного времени нет — этого мы не знаем. ' +
  'Извинись за задержку и предложи уточнить у администратора.';

const schema = {
  name: 'get_available_slots',
  description: 'Свободное время под КОНКРЕТНУЮ УСЛУГУ на дату. Если пациент назвал мастера — передай ' +
    'его staff_yc_id. Если НЕ называл — staff_yc_id не передавай: инструмент вернёт свободные окна ВСЕХ ' +
    'исполнителей услуги в staff_options, и выбор сделает пациент. Если у салона включена онлайн-запись — ' +
    'отдаёт слоты под услугу. Иначе считает свободность из графика (старты шагом 30 мин, куда услуга ' +
    'влезает целиком). Дата в формате YYYY-MM-DD. Само расписание (в какие дни работает) — get_available_dates.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера (из каталога услуг). НЕ передавай, если пациент специалиста не называл.' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги (из каталога услуг).' },
      date:          { type: 'string',  description: 'Дата YYYY-MM-DD.' },
    },
    required: ['service_yc_id', 'date'],
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

// Салон с токенами YClients. Обе ветки run() ходят в БД ПОСЛЕ своих проверок
// (filtered/staff_mismatch отвечают, не дёргая базу), поэтому запрос нельзя поднять
// выше ветвления — но и копировать его дважды незачем.
async function loadSalon(salonId) {
  return db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
}

// Пациент мастера не называл → окна считаем у ВСЕХ исполнителей услуги, а выбор
// отдаём пациенту. Раньше исполнителя выбирала сама модель (промпт это разрешал), и
// пациент молча получал одного специалиста — при том что цена зависит от мастера.
async function computeStaffOptions(salon, filter, staffList, serviceId, date, nowMs) {
  const candidates = (staffList || [])
    .filter(m => m && m.yc_id)
    .filter(m => svcFilter.isBookable(filter, serviceId, m.yc_id))
    // Сортировка ДО капа: порядок staffList наследуется от SELECT по staff_members
    // без ORDER BY, то есть меняется после UPDATE/автовакуума. Без неё кап срезал бы
    // случайных исполнителей: у услуги с 4+ мастерами пациент видел бы каждый раз
    // разный набор, невоспроизводимый при разборе инцидента.
    .sort((a, b) => a.yc_id - b.yc_id)
    .slice(0, MAX_STAFF_OPTIONS);
  const checked = await Promise.all(candidates.map(async (m) => {
    try {
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs);
      return { staff_yc_id: m.yc_id, name: m.name, position: null, slots: r.slots || [] };
    } catch (_) { return null; }   // сбой по одному мастеру не валит весь ответ
  }));
  const reachable = checked.filter(Boolean);
  const options = reachable
    .filter(o => o.slots.length)
    // Ближайшее окно — первым. Порядок детерминированный: тай-брейк по yc_id.
    .sort((a, b) => (toMin(a.slots[0].time) - toMin(b.slots[0].time)) || (a.staff_yc_id - b.staff_yc_id));
  // Наружу отдаём не только окна, но и СКОЛЬКО мастеров реально ответили: мастер,
  // до которого не достучались, выпадает из выдачи ровно так же, как занятый, и по
  // одному пустому списку «занят» от «не знаем» не отличить. Ровно та же развилка,
  // что у findAlternativeStaff (там она уже стоит: no_alternative_staff выставляется
  // только при reachable.length === others.length) — две ветки одного файла обязаны
  // лечить эту проблему одинаково.
  return { options, reachable: reachable.length, total: candidates.length };
}

async function run(salonId, input, ctx = {}) {
  const serviceId = input && input.service_yc_id;
  const staffId = input && input.staff_yc_id;
  const date = input && input.date;
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  if (!date) return { error: 'Нужна date (YYYY-MM-DD).' };
  // Услуга обязательна: без неё неизвестна длительность, и старты считались бы
  // «хотя бы на один шаг» — сеткой 30 мин. Инцидент 2026-07-31: так предложили
  // 11:30 перед чужой записью в 12:00, а записывали 60-минутную процедуру →
  // YClients отказал «время недоступно» уже ПОСЛЕ согласования с пациентом.
  if (!serviceId) {
    return { error: 'Нужен service_yc_id: без услуги нельзя проверить, влезает ли процедура в окно. ' +
      'Возьми точный id услуги из каталога услуг. Если вопрос про график мастера (в какие дни ' +
      'работает) — это get_available_dates, а не слоты.' };
  }
  // Мастер не назван — считаем окна у всех исполнителей услуги (выбор за пациентом).
  if (!staffId) {
    const filter = await settings.loadServiceFilterSafe(salonId);
    // Услугу, скрытую админкой ЦЕЛИКОМ, отсекаем ДО каталога и БД — тем же мягким
    // ответом, что и одномастерная ветка. Через isBookable отфильтровались бы ВСЕ
    // кандидаты, и наружу ушёл бы пустой выбор, который читается как «нет времени»:
    // модель начала бы предлагать другие даты вместо мягкого отказа. Скрытая услуга —
    // это «предлагать нельзя вообще», а не «на этот день никого нет».
    if (!svcFilter.decideServiceVisible(filter, serviceId)) return { slots: [], filtered: true };
    const chk = await staffGuard.checkStaffPerformsService(salonId, serviceId, 0);
    // Каталог не отдал исполнителей (fail-open предпроверки: сбой YClients или услуги
    // нет в каталоге) — перебирать некого. Отдать пустой выбор нельзя: он неотличим от
    // «на этот день никого нет», и модель начнёт предлагать другие даты, которых тоже
    // не проверить. Просим повторить вызов с конкретным мастером — id есть в каталоге.
    if (!chk.staffList || !chk.staffList.length) {
      return { error: 'Не удалось получить список исполнителей услуги. Вызови get_available_slots ещё раз, ' +
        'указав конкретный staff_yc_id (id мастера — в колонке мастеров строки услуги в каталоге).' };
    }
    const salon = await loadSalon(salonId);
    if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
    const { options, reachable, total } = await computeStaffOptions(salon, filter, chk.staffList, serviceId, date, nowMs);
    if (options.length) {
      return { staff_options: options, hint: options.length > 1 ? HINT_STAFF_CHOICE : HINT_STAFF_SINGLE };
    }
    // Пустой список окон САМ ПО СЕБЕ не означает «времени нет»: недостижимый мастер
    // (сбой YClients) выпадает из выдачи так же, как занятый. Утверждать «свободного
    // времени нет ни у кого» можно ТОЛЬКО когда все кандидаты реально ответили —
    // иначе это выдуманная причина отказа от лица клиники (тот же класс, что инцидент
    // 2026-07-31 с «это время только что заняли»).
    // Кандидатов не осталось после фильтра админки (скрыты пары со ВСЕМИ мастерами,
    // хотя услуга целиком не скрыта) — спрашивать было некого, и это решение салона,
    // а не сбой. Ответ тот же мягкий, что у скрытой услуги.
    if (!total) return { slots: [], filtered: true };
    if (!reachable) return { error: ERR_STAFF_UNREACHABLE };
    if (reachable < total) return { staff_options: [], hint: HINT_STAFF_PARTIAL };
    return { staff_options: [], no_staff_available: true, hint: HINT_NO_STAFF };
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
  const salon = await loadSalon(salonId);
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
