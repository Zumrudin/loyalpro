'use strict';

const { db } = require('../../../db');
const { ycGetBookTimes, ycGetStaffSeances, ycGetStaffSchedule } = require('../../yclients-booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const staffGuard = require('../staff-service-guard');
const eq = require('../equipment');
const eqContext = require('../equipment-context');
const leadTime = require('../lead-time');
const density = require('../slot-density');
const staffSchedule = require('../staff-schedule');

// Насколько вперёд смотрим график мастера, когда на запрошенную дату у него пусто.
// Отпуск исчисляется неделями (у PERI — 12–31.08), и вопрос пациента «а когда
// тогда?» должен получать ответ из ЭТОГО же вызова, а не из нового перебора дат.
const SCHEDULE_HORIZON_DAYS = 30;

const DEFAULT_STEP_MIN = 30;       // шаг предлагаемых стартов в fallback-режиме
const DEFAULT_DURATION_MIN = 60;   // если YClients не отдал duration услуги (как в get_parallel_slots)
const MAX_ALT_STAFF = 3;           // сколько других мастеров услуги проверяем при пустой выдаче
// Столько исполнителей проверяем, когда мастера выбирает пациент: каждый мастер —
// отдельный (параллельный) запрос в YClients, кап держит их число ограниченным.
// Значение НЕ произвольное: на боевом каталоге PERI максимум исполнителей у услуги — 4
// (42 услуги из 226), и кап обязан быть выше него, иначе перебор перестаёт быть полным
// на пятой части каталога. Инцидент 2026-08-06 (79200255591): при капе 3 и сортировке
// кандидатов по ВОЗРАСТАНИЮ yc_id мастер с наибольшим id — то есть самый НЕДАВНО
// заведённый — не попадал в перебор никогда. Пациенту с «Фотоомоложением» показали
// одну Татьяну, а нового врача (5708379) он вытащил сам вопросом «а доктор сегодня не
// принимает?» — дословный повтор инцидента 2026-08-01 («а почему к Тане не
// предлагаешь?»). Кап всё равно может срезать мастеров на другом салоне, поэтому
// хинты про неполноту перебора ниже остаются обязательными.
const MAX_STAFF_OPTIONS = 6;

const HINT_STAFF_CHOICE = 'Пациент специалиста не называл — выбор за НИМ, а не за тобой. ' +
  'Перечисли в ОДНОМ сообщении ВСЕХ из staff_options: имя, должность (position) и время ' +
  'ДОСЛОВНО из его offer_slots (это уже подобранные 1–2 времени; полный slots бери, только если ' +
  'пациент сам попросил другое), и спроси, к кому удобнее записать. НЕ выбирай сама и никого не советуй ' +
  'как «лучшего». Цену не называй, пока пациент сам о ней не спросил. НЕ утверждай, что это все ' +
  'специалисты клиники: здесь только те, у кого в этот день есть свободное время.';

// Выбор из одного варианта — не выбор, а лишний вопрос в переписке: «к кому вам
// удобнее?» при единственном мастере звучит нелепо и добавляет ход до записи.
const HINT_STAFF_SINGLE = 'Эту услугу в этот день ведёт один специалист — выбора не устраивай: ' +
  'назови его имя, должность (position) и время ДОСЛОВНО из offer_slots и предложи записать.';

// Тот же водораздел, что у ПУСТОЙ выдачи (HINT_STAFF_PARTIAL), только на непустой:
// «эту услугу ведёт один специалист» — утверждение обо ВСЕХ исполнителях, и по
// частичному перебору его делать нельзя. Инцидент 2026-08-06: хинт единственности
// ушёл модели ровно там, где четвёртого мастера никто не спрашивал, — и она его
// честно отработала, объявив единственной ту, у кого просто нашлись окна.
const HINT_STAFF_ONE_OF_PARTIAL = 'Свободное время нашлось у ОДНОГО специалиста из проверенных, ' +
  'но проверены НЕ ВСЕ исполнители услуги (часть не ответила или не попала в проверку). ' +
  'Назови его имя, должность (position) и время ДОСЛОВНО из offer_slots и предложи записать. ' +
  'НЕ утверждай, что он единственный, кто ведёт эту услугу, и что у остальных занято — ' +
  'этого мы не знаем.';

// Пустой staff_options с хинтом «перечисли ВСЕХ» — это указание перечислить пустоту:
// модель либо молчит, либо выдумывает мастера. Пустой день обязан звучать как пустой день.
const HINT_NO_STAFF = 'На эту дату свободного времени нет ни у одного исполнителя услуги — ' +
  'честно скажи об этом и предложи другой день (get_available_slots на другую дату).';

// Проверены НЕ ВСЕ исполнители: про непроверенных мы не знаем НИЧЕГО, поэтому «нет
// ни у кого» — уже выдумка. Но и молчать не о чем: у проверенных действительно пусто,
// и предложить другую дату честно.
// Формулировка покрывает ДВА источника неполноты, а не только сбой связи: мастер мог
// не ответить (YClients упал), а мог просто не попасть в перебор из-за MAX_STAFF_OPTIONS.
// Прежний текст «часть специалистов проверить не удалось (временный сбой)» во втором
// случае врал бы модели о причине — а причина отказа, выданная от лица клиники,
// это тот же класс инцидента, что «это время только что заняли» (2026-07-31).
const HINT_STAFF_PARTIAL = 'У проверенных исполнителей на эту дату свободного времени нет, ' +
  'но проверены НЕ ВСЕ специалисты услуги (часть не ответила или не попала в проверку). ' +
  'НЕ утверждай, что времени нет ни у кого — этого мы не знаем. Предложи посмотреть другую ' +
  'дату (get_available_slots на другую дату).';

// Мастера нет в графике на эту дату (отпуск/выходной). Инцидент 2026-08-10
// (79166524647): у главного врача отпуск 12–31.08, и на КАЖДУЮ из 9 проверенных
// дат тул отдавал голое `slots: []` — снаружи неотличимое от «работает, но день
// расписан». Модель молча перебирала даты, а потом выдала окна другого мастера
// за окна запрошенного. Отсюда две обязательные части текста: назвать причину
// пустоты и ЗАПРЕТИТЬ переклеивать чужие времена на этого мастера.
function hintStaffNotWorking(name, nextDate, checkedUntil) {
  const who = name ? `Мастер ${name}` : 'Запрошенный мастер';
  const when = nextDate
    ? `Его ближайший приёмный день — ${nextDate}: предложи пациенту именно его (слоты на эту дату запроси отдельным вызовом).`
    : `Рабочих дней у него нет и дальше — график проверен до ${checkedUntil}. Не перебирай даты вслепую: скажи пациенту, что мастер сейчас не принимает, и предложи другого специалиста или связь с администратором.`;
  return `${who} в этот день НЕ РАБОТАЕТ — его нет в графике (отпуск или выходной). ` +
    `У него не «всё занято»: свободного времени в этот день не существует и не появится. ${when} ` +
    'КАТЕГОРИЧЕСКИ НЕЛЬЗЯ называть пациенту любое время как время ЭТОГО мастера: ' +
    'ни из этой выдачи, ни из предыдущих ходов, ни из окон других специалистов.';
}

// Ни один исполнитель не ответил — это техническая неудача, а не занятость клиники.
// Тон и формулировка — как в одномастерной ветке («Не удалось получить слоты: …»).
const ERR_STAFF_UNREACHABLE = 'Не удалось получить слоты: ни один исполнитель услуги не ответил ' +
  '(временный сбой). НЕ говори пациенту, что свободного времени нет — этого мы не знаем. ' +
  'Извинись за задержку и предложи уточнить у администратора.';

// День у мастера ПУСТОЙ (ни одной записи) — предлагать «плотное» время не из чего:
// любое разрывает свободный день на две дыры. Решение салона (07.08): выбор половины
// дня делает пациент. Хинт намеренно требует НЕ называть время: без этого модель
// берёт самое раннее из slots — ровно то поведение, из-за которого плотную запись и
// делали (инцидент 2026-08-06).
const HINT_FREE_DAY = 'У этого мастера на выбранную дату НЕТ ни одной записи — свободен весь день, ' +
  'и подбирать плотное время не из чего. Конкретное время пациенту НЕ называй: скажи, что свободные ' +
  'окошки есть в течение всего дня, и спроси, в какой половине дня удобнее (до обеда, после обеда или ' +
  'вечером). Когда пациент ответит — вызови get_available_slots ЕЩЁ РАЗ с тем же мастером и услугой и ' +
  'параметром day_part (morning / afternoon / evening) и назови время ДОСЛОВНО из offer_slots. ' +
  'Если пациент половину дня или конкретное время уже назвал сам — ничего не спрашивай, сразу вызывай ' +
  'с day_part (а названное им время подтверждай, если оно есть в slots).';

// Пациент назвал половину дня, а в ней всё занято. Второй раз спрашивать нечего —
// это был бы тот же вопрос по кругу; предлагаем найденное время в остальном дне.
const HINT_DAY_PART_EMPTY = 'В названной пациентом половине дня свободные окна ЗАНЯТЫ — там записать ' +
  'не получится. Скажи об этом честно, без выдуманных причин, и в том же сообщении предложи время ' +
  'ДОСЛОВНО из offer_slots (это время в другой части того же дня) либо предложи другой день. ' +
  'Второй раз про половину дня не спрашивай.';

// Тот же случай в перечислении специалистов (пациент мастера не назвал). Времени по
// таким мастерам нет вовсе, а хинт выбора требует «назови время» — без этой оговорки
// модель возьмёт время из полного slots, то есть самое раннее.
const HINT_FREE_DAY_OPTIONS = ' У специалистов с free_day:true на эту дату НЕТ ни одной записи — ' +
  'весь день свободен: время по ним НЕ называй, скажи про них «свободное время есть в течение дня». ' +
  'В том же сообщении спроси, в какую половину дня удобнее (до обеда, после обеда или вечером) — ' +
  'а если специалистов несколько, то и к кому. Когда пациент ответит — вызови get_available_slots ' +
  'с его staff_yc_id и параметром day_part (morning / afternoon / evening).';

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
      day_part:      { type: 'string',  enum: ['morning', 'afternoon', 'evening'],
        description: 'Половина дня, которую назвал ПАЦИЕНТ: morning — до обеда (до 14:00), ' +
          'afternoon — после обеда (с 14:00), evening — вечером (с 17:00). Передавай, когда пациент ' +
          'сказал, в какую часть дня ему удобно (в том числе в ответ на твой вопрос при free_day). ' +
          'Полный slots от этого не сужается — сужается только подобранное offer_slots.' },
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
async function computeStaffSlots(salon, staffId, serviceId, date, nowMs, dayPart) {
  // 1) Онлайн-запись включена и известна услуга → точные слоты под услугу.
  if (serviceId) {
    const times = await ycGetBookTimes(salon, staffId, date, [serviceId]);
    const slots = (Array.isArray(times) ? times : []).map(t => ({
      time: t.time, datetime: t.datetime, seance_length: t.seance_length,
    }));
    if (slots.length) {
      const out = dropDisallowedStarts({ slots, source: 'booking' }, date, nowMs);
      // Занятость для ранжирования здесь взять неоткуда: онлайн-запись отдаёт
      // только свободные старты. Тянем сетку смены ОТДЕЛЬНО — это один лишний
      // запрос, но только на салонах с включённой онлайн-записью (у PERI это
      // 4 услуги из 317, обычный путь идёт ниже и сетку уже загрузил).
      // Сбой → занятость НЕИЗВЕСТНА (busyKnown=false) → offer_slots = самые ранние,
      // то есть ровно сегодняшнее поведение. Ранжирование не должно стоить пациенту
      // ответа. Пустую занятость от неизвестной отличаем именно флагом: молчание
      // сетки нельзя выдать за «день полностью свободен» (это вопрос пациенту о
      // половине дня там, где у мастера может быть занят весь вечер).
      let busy = [];
      let busyKnown = false;
      try {
        const seances = await ycGetStaffSeances(salon, staffId, date);
        // ПУСТАЯ сетка — это не «день полностью свободен», а отсутствие информации:
        // так выглядит и день, в который мастер не работает, и молчание API. При этом
        // онлайн-запись выше уже отдала реальные слоты, то есть мастер работает —
        // выдать пустоту за свободный день значило бы спросить пациента о половине
        // дня там, где у мастера может быть занят весь вечер.
        busyKnown = Array.isArray(seances) && seances.length > 0;
        busy = density.seancesToBusy(seances);
      } catch (_) { busyKnown = false; busy = []; }
      applyOffer(out, out.slots, busy, { busyKnown, dayPart });
      return out;
    }
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
  const ranked = dropDisallowedStarts(out, date, nowMs);
  // Плотность считаем ПОСЛЕ lead-time и ПОСЛЕ вычета занятого оборудования:
  // иначе порекомендуем старт, который сам же отфильтровали, и create_booking
  // упрётся в save_if_busy:false уже после согласования времени с пациентом.
  applyOffer(ranked, ranked.slots, density.seancesToBusy(seances),
    // Пустая сетка = мастер в этот день не работает (тогда и слотов нет), а не
    // «свободен весь день» — тот же водораздел, что в booking-ветке выше.
    { busyKnown: Array.isArray(seances) && seances.length > 0, dayPart, durationMin: svcDurationMin });
  return ranked;
}

// Решение «что предложить» приезжает из чистого модуля, а тут только раскладывается
// по полям ответа. Флаги ставятся ТОЛЬКО когда истинны: `free_day:false` в выдаче
// модель читала бы как отдельный факт («день занят»), которого мы не утверждаем.
function applyOffer(out, slots, busy, opts) {
  const r = density.chooseOffer(slots, busy, opts);
  out.offer_slots = r.offer;
  if (r.freeDay) out.free_day = true;
  if (r.dayPartEmpty) out.day_part_empty = true;
  return out;
}

// У запрошенного мастера пусто → проверяем других исполнителей ЭТОЙ услуги на ту же
// дату. Инцидент 2026-08-01: «Голливуд» на завтра — модель проверила только Юлию и
// сказала «окошек нет», хотя у Татьяны было 14:00; клиент сам вытащил альтернативу
// вопросом «а почему к Тане не предлагаешь?». Задача — довести до записи: альтернативу
// подсвечивает сам инструмент, а не память модели.
async function findAlternativeStaff(salon, filter, staffList, staffId, serviceId, date, nowMs, dayPart) {
  const eligible = (staffList || [])
    .filter(m => m && m.yc_id && String(m.yc_id) !== String(staffId))
    .filter(m => svcFilter.isBookable(filter, serviceId, m.yc_id))
    // Сортировка ДО капа — та же причина, что в computeStaffOptions: порядок staffList
    // наследуется от SELECT по staff_members без ORDER BY и меняется после
    // UPDATE/автовакуума, поэтому без неё кап срезал бы случайных исполнителей и
    // предложенная альтернатива была бы невоспроизводима при разборе инцидента.
    .sort((a, b) => Number(a.yc_id) - Number(b.yc_id));
  // Кап считаем ОТДЕЛЬНО от числа подходящих: no_alternative_staff — утверждение
  // обо ВСЕХ исполнителях услуги, а перебираем мы максимум MAX_ALT_STAFF.
  const others = eligible.slice(0, MAX_ALT_STAFF);
  if (!others.length) return null;
  const checked = await Promise.all(others.map(async (m) => {
    try {
      // В booking-ветке computeStaffSlots делает ДОПОЛНИТЕЛЬНЫЙ запрос сетки на
      // КАЖДОГО мастера (до MAX_ALT_STAFF штук) — цена осознанная: offer_slots
      // нужен по каждому специалисту отдельно, плотность считается по ЕГО дню.
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs, dayPart);
      const item = { staff_yc_id: m.yc_id, name: m.name, slots: r.slots || [], offer_slots: r.offer_slots || [] };
      if (r.free_day) item.free_day = true;   // весь день свободен — времени по нему не называем
      return item;
    } catch (_) { return null; }   // сбой по одному мастеру не валит весь ответ
  }));
  const reachable = checked.filter(Boolean);
  const withSlots = reachable.filter(a => a.slots.length);
  if (withSlots.length) return { alternative_staff: withSlots };
  // Сказать «ни у кого» можно, только когда проверка РЕАЛЬНО состоялась по всем:
  // все подходящие исполнители попали в перебор (кап никого не срезал) И каждый
  // ответил. Непроверенный мастер выглядит снаружи ровно как занятый — выдать его
  // за занятого значит соврать пациенту от лица клиники.
  if (reachable.length === others.length && others.length === eligible.length) {
    return { no_alternative_staff: true };
  }
  return null;
}

// YYYY-MM-DD + n дней. Москва — фиксированный UTC+3 без перехода на летнее время,
// поэтому арифметика по UTC-полуночи здесь безопасна (тот же приём, что в
// tools/get-available-dates.js).
function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

// Работает ли мастер в этот день — спрашиваем ТОЛЬКО когда слотов не нашлось:
// на счастливом пути это лишний запрос в YClients на каждом ходу каждого диалога.
// Строго best-effort: сбой графика оставляет выдачу ровно такой, какой она была
// до фикса. Выдуманный отпуск дороже неназванного — это тот же класс ошибки, что
// «это время только что заняли» (инцидент 2026-07-31).
async function describeStaffSchedule(salon, staffId, date) {
  try {
    const rows = await ycGetStaffSchedule(salon, staffId, date, addDays(date, SCHEDULE_HORIZON_DAYS));
    return staffSchedule.summarizeWorkingDays(rows, { date });
  } catch (_) {
    return { unknown: true };
  }
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
async function computeStaffOptions(salon, filter, staffList, serviceId, date, nowMs, dayPart) {
  const eligible = (staffList || [])
    .filter(m => m && m.yc_id)
    .filter(m => svcFilter.isBookable(filter, serviceId, m.yc_id))
    // Сортировка ДО капа: порядок staffList наследуется от SELECT по staff_members
    // без ORDER BY, то есть меняется после UPDATE/автовакуума. Без неё кап срезал бы
    // случайных исполнителей: у услуги с 4+ мастерами пациент видел бы каждый раз
    // разный набор, невоспроизводимый при разборе инцидента.
    // Number(): весь остальной файл сравнивает мастеров через String(...) — типам
    // yc_id тут не верят. На строках вычитание дало бы NaN, sort молча оставил бы
    // порядок SELECT'а, и детерминированность, ради которой сортировка и стоит,
    // тихо исчезла бы.
    .sort((a, b) => Number(a.yc_id) - Number(b.yc_id));
  const candidates = eligible.slice(0, MAX_STAFF_OPTIONS);
  const checked = await Promise.all(candidates.map(async (m) => {
    try {
      // В booking-ветке computeStaffSlots делает ДОПОЛНИТЕЛЬНЫЙ запрос сетки на
      // КАЖДОГО мастера (до MAX_STAFF_OPTIONS штук) — цена осознанная: offer_slots
      // нужен по каждому специалисту отдельно, плотность считается по ЕГО дню.
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs, dayPart);
      const item = {
        staff_yc_id: m.yc_id, name: m.name, position: null,
        slots: r.slots || [], offer_slots: r.offer_slots || [],
      };
      if (r.free_day) item.free_day = true;   // весь день свободен — времени по нему не называем
      return item;
    } catch (_) { return null; }   // сбой по одному мастеру не валит весь ответ
  }));
  const reachable = checked.filter(Boolean);
  const options = reachable
    .filter(o => o.slots.length)
    // Ближайшее окно — первым. Порядок детерминированный: тай-брейк по yc_id
    // (Number по той же причине, что и в сортировке кандидатов выше).
    .sort((a, b) => (toMin(a.slots[0].time) - toMin(b.slots[0].time))
      || (Number(a.staff_yc_id) - Number(b.staff_yc_id)));
  // Наружу отдаём три РАЗНЫХ числа, потому что пустой список окон имеет три разные
  // причины, и только одна из них — «занято»:
  //   total    — сколько исполнителей у услуги вообще подходит (после фильтра админки);
  //   checked  — скольких мы успели спросить (кап MAX_STAFF_OPTIONS режет остальных);
  //   reachable— сколько из спрошенных реально ответили (остальные — сбой YClients).
  // Мастер непроверенный и мастер недостижимый выпадают из выдачи ровно так же, как
  // занятый, и по одному пустому списку их не различить. Ровно та же развилка, что у
  // findAlternativeStaff — две ветки одного файла обязаны лечить это одинаково.
  return { options, reachable: reachable.length, checked: candidates.length, total: eligible.length };
}

// Должность — из карточки сотрудника (то же поле, что отдаёт list_staff): хинт требует
// назвать её по каждому специалисту, а в каталоге услуг должностей нет — без подстановки
// модель либо промолчит о должности, либо выдумает её. Мутируем на месте: строго
// best-effort, сбой БД оставляет position=null, слоты от этого не страдают.
async function attachPositions(salonId, options) {
  if (!options.length) return;
  try {
    const rows = await db.any(
      `SELECT yclients_staff_id, specialization
         FROM staff_members
        WHERE salon_id = $1 AND yclients_staff_id = ANY($2::int[])`,
      [salonId, options.map(o => Number(o.staff_yc_id))]);
    const byId = new Map((rows || []).map(r => [Number(r.yclients_staff_id), r.specialization || null]));
    for (const o of options) o.position = byId.get(Number(o.staff_yc_id)) || null;
  } catch (_) { /* без должности реплика просто короче */ }
}

async function run(salonId, input, ctx = {}) {
  const serviceId = input && input.service_yc_id;
  const staffId = input && input.staff_yc_id;
  const date = input && input.date;
  // Половина дня, названная ПАЦИЕНТОМ. Валидацию делает сам density (незнакомое
  // значение фильтром не считается) — молча сужать выдачу по опечатке модели нельзя.
  const dayPart = input && input.day_part;
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
    const { options, reachable, checked, total } = await computeStaffOptions(salon, filter, chk.staffList, serviceId, date, nowMs, dayPart);
    if (options.length) {
      await attachPositions(salonId, options);
      // «Один специалист» законно ровно там же, где законно «ни у кого»: кап никого не
      // срезал (checked === total) И все спрошенные ответили (reachable === checked).
      // Иначе единственность — выдумка о клинике поверх непроверенных мастеров.
      const exhaustive = reachable === checked && checked === total;
      let hint = options.length > 1 ? HINT_STAFF_CHOICE
        : (exhaustive ? HINT_STAFF_SINGLE : HINT_STAFF_ONE_OF_PARTIAL);
      // Хоть у одного мастера день пустой — базовый хинт («назови время из его
      // offer_slots») по нему невыполним: времени там нет. Оговорка дописывается,
      // а не заменяет хинт: в смешанном дне остальные мастера идут как обычно.
      if (options.some(o => o.free_day)) hint += HINT_FREE_DAY_OPTIONS;
      return { staff_options: options, hint };
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
    // «Ни у кого» законно ровно в одном случае: кап никого не срезал (checked === total)
    // И все спрошенные ответили (reachable === checked). Услугу может вести пятеро, а
    // спрашиваем мы троих — молчание про 4-го и 5-го нельзя выдавать за занятость
    // клиники: это дословный повтор инцидента 2026-08-01 («а почему к Тане не
    // предлагаешь?»), только на дефолтном пути любого «а когда можно?».
    if (reachable < checked || checked < total) return { staff_options: [], hint: HINT_STAFF_PARTIAL };
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
    const out = await computeStaffSlots(salon, staffId, serviceId, date, nowMs, dayPart);
    // Имя запрошенного мастера едет рядом с его слотами — оно нужно reply-guard'у
    // (checkStaffAttribution): без него оркестратор знает, что выдача пуста, но не
    // знает, ЧЬЯ, и приписанное чужое время сверять не с чем (инцидент 10.08).
    // Каталог мог не отдать исполнителей (fail-open предпроверки) — тогда поля нет.
    const staffName = (staffList.find(m => String(m.yc_id) === String(staffId)) || {}).name || null;
    if (staffName) out.staff_name = staffName;
    if (out.slots.length) {
      // Хинт про пустой день и про занятую половину дня — единственные случаи, где
      // одномастерная выдача что-то ОБЪЯСНЯЕТ модели: время в offer_slots её и так
      // ведёт (правило промпта «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ»).
      if (out.free_day) out.hint = HINT_FREE_DAY;
      else if (out.day_part_empty) out.hint = HINT_DAY_PART_EMPTY;
      return out;
    }
    // У запрошенного мастера на эту дату пусто → сразу подсвечиваем альтернативу:
    // те же слоты у других исполнителей услуги, чтобы клиент не ушёл без записи.
    // Параллельно выясняем ПРИЧИНУ пустоты: «день расписан» и «мастера нет в
    // графике» до 10.08.2026 выглядели снаружи одинаково (инцидент 79166524647).
    const [alt, sched] = await Promise.all([
      findAlternativeStaff(salon, filter, staffList, staffId, serviceId, date, nowMs, dayPart),
      describeStaffSchedule(salon, staffId, date),
    ]);
    if (alt && alt.alternative_staff) {
      out.alternative_staff = alt.alternative_staff;
      out.hint = 'У выбранного мастера на эту дату свободного времени нет, но ЭТУ ЖЕ услугу в этот день ' +
        'выполняют другие мастера — их реальные свободные окна в alternative_staff. Предложи пациенту ' +
        'записаться к одному из них (назови имя), время бери ДОСЛОВНО из их offer_slots. ' +
        // Инцидент 2026-08-04: пациент про мастера не спрашивал, мастера для проверки
        // выбрала сама модель — и пациент получил «у главного врача Пери Исамудиновны
        // на завтра всё занято». Кого проверяли внутри, пациента не касается.
        'Если пациент этого мастера сам не спрашивал (выбрала его ты) — НЕ говори, что у него занято: ' +
        'просто предложи специалиста с окнами и его время, без отчёта о проверке.';
      // Тот же случай, что и в staff_options: у альтернативного мастера день может быть
      // пустым, и тогда «время из его offer_slots» назвать физически нечем.
      if (out.alternative_staff.some(a => a.free_day)) out.hint += HINT_FREE_DAY_OPTIONS;
    } else if (alt && alt.no_alternative_staff) {
      out.no_alternative_staff = true;   // проверены ВСЕ исполнители услуги — на дату пусто у всех
    }
    // Отпуск/выходной запрошенного мастера — САМЫЙ важный факт этой выдачи, поэтому
    // его хинт идёт ПЕРВЫМ, а альтернатива дописывается следом: оба факта нужны
    // одновременно, иначе модель склеит их в «у Пери есть окна» (инцидент 10.08).
    if (!sched.unknown && !sched.working) {
      out.staff_not_working = true;
      out.staff_next_working_date = sched.nextWorkingDate;
      if (!sched.nextWorkingDate) out.staff_schedule_checked_until = sched.checkedUntil;
      const notWorking = hintStaffNotWorking(staffName, sched.nextWorkingDate, sched.checkedUntil);
      out.hint = out.hint ? `${notWorking} ${out.hint}` : notWorking;
    }
    return out;
  } catch (e) {
    return { error: `Не удалось получить слоты: ${e.message}` };
  }
}

// MAX_STAFF_OPTIONS экспортируется РАДИ ТЕСТОВ: фикстуры с зашитой «тройкой» мастеров
// остались бы зелёными и после сдвига капа — ровно на этом инцидент 2026-08-06 и держался.
module.exports = { schema, run, seancesToRanges, rangesToSlots, toMin, toHHMM, MAX_STAFF_OPTIONS };
