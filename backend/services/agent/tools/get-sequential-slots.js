'use strict';

const { db } = require('../../../db');
const { ycGetStaffSeances } = require('../../yclients-booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const listServices = require('./list-services');
const { seancesToRanges } = require('./get-available-slots');
const eq = require('../equipment');
const eqContext = require('../equipment-context');
const seq = require('../sequential');
const seqOffers = require('../sequential-offers');
const leadTime = require('../lead-time');

// ── Несколько услуг ПОДРЯД одному клиенту («встык»). ────────────────────────
// Отдельный инструмент, а не «сравни слоты двух услуг сама»: стыковка окон —
// интервальная арифметика, на которой модель ошибается (см. get_parallel_slots
// для записи двоих ПАРАЛЛЕЛЬНО). Здесь код сам подбирает исполнителей по
// каталогу, сканирует до HORIZON_DAYS дней и отдаёт готовые варианты по
// приоритетной лестнице: всё у текущего мастера → всё у другого одного
// мастера → разные мастера по очереди. Разбор 26.07: без этого слабые модели
// выдумывали слоты и ходили кругами.

const HORIZON_DAYS = 7;        // дней вперёд после запрошенной даты
const MAX_DATES = 3;           // дат с вариантами в выдаче
const MAX_STARTS = 4;          // стартов на вариант
const MAX_OTHER_STAFF = 3;     // «универсалов» помимо текущего мастера
const MAX_MIXED_COMBOS = 6;    // потолок комбинаций мастеров в mixed
const MAX_VARIANTS = 6;        // суммарный потолок вариантов в ответе (диета токенов)
const DEFAULT_DURATION_MIN = 60;

const schema = {
  name: 'get_sequential_slots',
  description: 'Подобрать время для НЕСКОЛЬКИХ услуг ПОДРЯД одному пациенту за один визит ' +
    '(«встык», одна за другой; НЕ для двоих гостей одновременно — это get_parallel_slots). ' +
    'Сам находит исполнителей по каталогу, проверяет текущего мастера, других мастеров и ' +
    'ближайшие дни (до 7) и возвращает готовые варианты по приоритету: всё у текущего мастера → ' +
    'всё у другого одного мастера → разные мастера по очереди; вариант с перерывом помечен ' +
    'with_gap/gap_minutes. Вызывай ВМЕСТО ручного сравнения слотов разных услуг. ' +
    'Нужны yc_id услуг из каталога услуг в желаемом порядке выполнения. Дата YYYY-MM-DD. ' +
    'Выбранный пациентом вариант оформляй инструментом book_chain по option_id старта.',
  input_schema: {
    type: 'object',
    properties: {
      services: {
        type: 'array', minItems: 2,
        description: 'Услуги в желаемом порядке выполнения (минимум 2).',
        items: {
          type: 'object',
          properties: { service_yc_id: { type: 'integer', description: 'YClients-id услуги.' } },
          required: ['service_yc_id'],
          additionalProperties: false,
        },
      },
      date: { type: 'string', description: 'С какого дня искать, YYYY-MM-DD.' },
      preferred_staff_yc_id: {
        type: 'integer',
        description: 'Мастер, у которого пациент уже записан или которого предпочитает — приоритет сохранить всё у него.',
      },
      first_booked_datetime: {
        type: 'string',
        description: 'Если ПЕРВАЯ услуга цепочки УЖЕ забронирована и пациент хочет ДОБАВИТЬ следующие ПОСЛЕ неё, НЕ перенося её — её дата и время в формате YYYY-MM-DDTHH:MM. Тогда первая услуга закрепляется как есть (её слот в графике занят собственной записью), а инструмент ищет стыковку ТОЛЬКО последующих услуг в тот же день. Указывай вместе с preferred_staff_yc_id — мастером уже записанной услуги.',
      },
    },
    required: ['services', 'date'],
    additionalProperties: false,
  },
};

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Разбор datetime уже забронированной первой услуги (якорь): день + минуты от
// полуночи. Принимает 'YYYY-MM-DDTHH:MM[:SS][±TZ]' и 'YYYY-MM-DD HH:MM'. null — не распознано.
function parseAnchor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return { day: m[1], minutes: Number(m[2]) * 60 + Number(m[3]) };
}

// Текущий момент по Москве (как в get_available_slots/get_parallel_slots).
function moscowNow(ms) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const [h, m] = hm.split(':').map(Number);
  return { date, minutes: h * 60 + m };
}

async function run(salonId, input, ctx = {}) {
  const date = input && input.date;
  const items = (input && Array.isArray(input.services)) ? input.services : [];
  const preferredId = input && input.preferred_staff_yc_id ? String(input.preferred_staff_yc_id) : null;  // falsy 0 = «нет предпочтения» — реальных yc_id 0 не бывает
  const anchor = parseAnchor(input && input.first_booked_datetime);  // первая услуга уже забронирована — не двигаем её
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || items.length < 2) {
    return { error: 'Нужны date (YYYY-MM-DD) и минимум две услуги в services.' };
  }

  const salon = await db.oneOrNone(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };

  // Исполнители — только из каталога (per-staff привязка, общий /services урезан).
  // Без каталога стыковать не из чего — честная ошибка, модель уйдёт в get_available_slots.
  let catalog = null;
  try { catalog = await listServices.run(salonId); } catch (_) { catalog = null; }
  if (!catalog || !Array.isArray(catalog.services) || !catalog.services.length) {
    return { error: 'Каталог услуг недоступен — подбери время по каждой услуге через get_available_slots.' };
  }

  const filter = await settings.loadServiceFilterSafe(salonId);

  // Услуги цепочки в порядке выполнения + допустимые исполнители каждой.
  const chainSvcs = [];
  const performersByService = {};
  for (const it of items) {
    const svcId = it && it.service_yc_id;
    const svc = catalog.services.find(s => String(s.yc_id) === String(svcId));
    if (!svc) return { error: `Услуга ${svcId} не найдена в каталоге — возьми верный yc_id из каталога услуг.` };
    const performers = (svc.staff || [])
      .filter(m => m && m.yc_id && svcFilter.isBookable(filter, svcId, m.yc_id));
    if (!performers.length) {
      return {
        variants: [], filtered: true,
        hint: 'Ни один мастер сейчас не доступен для записи на одну из услуг — не подбирай другого мастера ' +
          'для этой связки, предложи другую услугу или отдельные визиты.',
      };
    }
    chainSvcs.push({ yc_id: svcId, title: svc.title, performers });
    performersByService[String(svcId)] = performers.map(m => m.name).filter(Boolean);
  }

  // «Универсалы» — делают ВСЕ услуги цепочки (порядок — как в каталоге).
  const universal = chainSvcs[0].performers.filter(m =>
    chainSvcs.every(s => s.performers.some(p => String(p.yc_id) === String(m.yc_id))));
  const preferredUniversal =
    (preferredId && universal.find(m => String(m.yc_id) === preferredId)) || null;
  const preferredCannot = preferredId
    ? chainSvcs.filter(s => !s.performers.some(p => String(p.yc_id) === preferredId)).map(s => s.title)
    : [];

  // Кандидаты-назначения по приоритетной лестнице: staff[i] ведёт услугу i.
  const assignments = [];
  if (preferredUniversal) {
    assignments.push({ type: 'same_staff', staff: chainSvcs.map(() => preferredUniversal) });
  }
  for (const m of universal.filter(m => String(m.yc_id) !== preferredId).slice(0, MAX_OTHER_STAFF)) {
    assignments.push({ type: 'other_staff', staff: chainSvcs.map(() => m) });
  }
  // Микс: на услугу — preferred, если делает, иначе до 2 исполнителей; комбо капаем.
  const perSvcChoices = chainSvcs.map(s => {
    const pref = s.performers.find(p => String(p.yc_id) === preferredId);
    return pref ? [pref] : s.performers.slice(0, 2);
  });
  let combos = [[]];
  for (const choices of perSvcChoices) {
    const next = [];
    for (const c of combos) for (const ch of choices) next.push([...c, ch]);
    // Обрезка ВНУТРИ накопления порядко-зависима: при 3+ услугах теряются комбо из
    // поздних выборов ранних услуг. Для типичных 2 услуг полный продукт ≤4 — не влияет.
    combos = next.slice(0, MAX_MIXED_COMBOS);
  }
  for (const combo of combos) {
    if (new Set(combo.map(m => String(m.yc_id))).size === 1) continue;  // одиночный мастер уже покрыт выше
    assignments.push({ type: 'mixed', staff: combo });
  }

  const now = moscowNow(nowMs);
  const seancesCache = new Map();   // `${staffYcId}|${day}` → ranges кресла
  let scheduleFailures = 0;   // сбои получения графика: не путать «не работает» и «не смогли узнать»
  const getStaffRanges = async (staffYcId, day) => {
    const k = `${staffYcId}|${day}`;
    if (!seancesCache.has(k)) {
      let s = [];
      try { s = await ycGetStaffSeances(salon, staffYcId, day); } catch (_) { s = []; scheduleFailures++; }
      seancesCache.set(k, seancesToRanges(s));
    }
    return seancesCache.get(k);
  };

  // entries для sequential.js: окна мастера услуги минус занятость её аппаратов.
  const entriesFor = async (assignment, day, eqCtx) => {
    const entries = [];
    for (let i = 0; i < chainSvcs.length; i++) {
      const svc = chainSvcs[i];
      const staff = assignment.staff[i];
      let ranges = await getStaffRanges(staff.yc_id, day);
      const busy = eqContext.busyForService(eqCtx, svc.yc_id);
      if (busy.length) ranges = eq.subtractRanges(ranges, busy);
      entries.push({
        ranges,
        durationMin: eqContext.durationMin(eqCtx, svc.yc_id) || DEFAULT_DURATION_MIN,
        staff, svc,
      });
    }
    return entries;
  };

  const buildVariant = (assignment, day, entries, chains) => {
    const staff = [];
    for (const m of assignment.staff) {
      if (!staff.some(u => String(u.yc_id) === String(m.yc_id))) {
        staff.push({ yc_id: m.yc_id, name: m.name });
      }
    }
    return {
      type: assignment.type, date: day, staff,
      starts: chains.map(c => {
        const chain = c.starts.map((s, i) => ({
          service_yc_id: entries[i].svc.yc_id,
          service_title: entries[i].svc.title,
          staff_yc_id: entries[i].staff.yc_id,
          // Имя мастера уже есть в назначении (пришло из каталога) — кладём в звено,
          // чтобы рендер активных вариантов в промпте называл человека, а не id.
          staff_name: entries[i].staff.name || null,
          datetime: `${day}T${eq.toHHMM(s)}:00+03:00`,
          seance_length: entries[i].durationMin * 60,
        }));
        // Как исполнять этот старт. Одну запись двумя услугами можно оформить ТОЛЬКО
        // когда мастер один И услуги идут без перерыва: modify_booking_services
        // пересчитывает длительность как непрерывную сумму от старта и не умеет
        // выразить зазор — при перерыве такая запись стёрла бы его и могла занять
        // аппарат, забронированный в это время чужой записью. Поэтому разные
        // мастера ИЛИ любой внутренний перерыв → отдельная запись на каждый шаг.
        const oneStaff = new Set(chain.map(l => String(l.staff_yc_id))).size === 1;
        const bookingMode = (oneStaff && c.totalGap === 0) ? 'single_record' : 'separate_records';
        return { time: eq.toHHMM(c.start), gap_minutes: c.totalGap, booking_mode: bookingMode, chain };
      }),
    };
  };

  const variants = [];

  if (anchor) {
    // ── Якорный режим: первая услуга УЖЕ забронирована, её НЕ двигаем. ──
    // Закрепляем первую услугу в anchor.minutes (её слот занят собственной
    // записью, поэтому свободных окон под неё нет), ищем стыковку только
    // последующих услуг в тот же день у их исполнителей.
    const day = anchor.day;
    const bookedName = (() => {
      for (const s of catalog.services) {
        const m = (s.staff || []).find(x => String(x.yc_id) === preferredId);
        if (m && m.name) return m.name;
      }
      return null;
    })();
    const bookedFirst = { yc_id: preferredId ? Number(preferredId) : null, name: bookedName };
    const subs = chainSvcs.slice(1);
    const bookedDoesAllSubs = preferredId
      && subs.every(s => s.performers.some(p => String(p.yc_id) === preferredId));

    const anchoredAssignments = [];
    if (bookedDoesAllSubs) {
      anchoredAssignments.push({ type: 'same_staff', staff: chainSvcs.map(() => bookedFirst) });
    }
    // Микс: первую ведёт записанный мастер, на каждую последующую — preferred, если делает, иначе до 2 исполнителей.
    const perSubChoices = subs.map(s => {
      const pref = s.performers.find(p => String(p.yc_id) === preferredId);
      return pref ? [pref] : s.performers.slice(0, 2);
    });
    let combos = [[]];
    for (const choices of perSubChoices) {
      const next = [];
      for (const c of combos) for (const ch of choices) next.push([...c, ch]);
      combos = next.slice(0, MAX_MIXED_COMBOS);
    }
    for (const combo of combos) {
      const staff = [bookedFirst, ...combo];
      if (preferredId && staff.every(m => String(m.yc_id) === preferredId)) continue;  // всё у записанного — уже покрыто same_staff
      anchoredAssignments.push({ type: 'mixed', staff });
    }

    const eqCtx = await eqContext.loadEquipmentContext(salon, day);
    for (const a of anchoredAssignments) {
      const entries = await entriesFor(a, day, eqCtx);
      // Одна цепочка от фиксированного якоря: последующие с ближайшего свободного времени.
      const chain = seq.fitChain(entries, anchor.minutes, { anchorFirst: true, maxLinkGap: Infinity });
      if (!chain) continue;
      // Минимальный срок до визита: якорная (уже записанная) услуга остаётся как
      // есть, но ДОБАВЛЯЕМЫЕ записи подчиняются общему правилу (день в день +2ч,
      // вечером на завтра — с 12:00) — иначе create_booking внутри book_chain
      // отклонит звено и цепочка развалится в partial.
      const anchorFloor = leadTime.minStartMin(now, day);
      if (anchorFloor && chain.starts.slice(1).some(s => s < anchorFloor)) continue;
      const v = buildVariant(a, day, entries,
        [{ start: chain.starts[0], starts: chain.starts, totalGap: chain.totalGap }]);
      v.anchored = true;
      if (chain.totalGap > seq.MAX_LINK_GAP) v.with_gap = true;
      // Первую услугу НЕ создаём заново (already_booked); последующие — отдельными записями.
      for (const st of v.starts) {
        st.booking_mode = 'separate_records';
        if (st.chain[0]) st.chain[0].already_booked = true;
      }
      variants.push(v);
    }
  } else {
    const datesWithHits = new Set();
    let foundSameStaff = false;
    for (let d = 0; d <= HORIZON_DAYS; d++) {
      const day = addDays(date, d);
      const eqCtx = await eqContext.loadEquipmentContext(salon, day);

      // Минимальный срок до визита (день в день +2ч, вечером на завтра — с 12:00)
      // заодно отрезает и прошедшие старты сегодняшнего дня.
      const dayFloor = leadTime.minStartMin(now, day);

      for (const a of assignments) {
        const entries = await entriesFor(a, day, eqCtx);
        let chains = seq.chainStarts(entries);
        if (dayFloor) chains = chains.filter(c => c.start >= dayFloor);
        if (!chains.length) continue;
        variants.push(buildVariant(a, day, entries, chains.slice(0, MAX_STARTS)));
        datesWithHits.add(day);
        if (a.type === 'same_staff') foundSameStaff = true;
      }

      // «С перерывом» — только для запрошенного дня и только там, где встык не вышло.
      if (d === 0) {
        for (const a of assignments) {
          if (variants.some(v => v.date === day && v.type === a.type)) continue;
          const entries = await entriesFor(a, day, eqCtx);
          let best = seq.bestGapChain(entries);
          if (best && dayFloor && best.start < dayFloor) best = null;
          if (!best || best.totalGap <= seq.MAX_LINK_GAP) continue;  // ≤15 мин нашёл бы chainStarts
          const v = buildVariant(a, day, entries, [best]);
          v.with_gap = true;
          variants.push(v);
          datesWithHits.add(day);
          break;  // одного честного варианта «с перерывом» достаточно
        }
      }

      // Ранний стоп: всё у текущего мастера найдено, либо дат уже достаточно.
      if (foundSameStaff || datesWithHits.size >= MAX_DATES) break;
    }
  }

  // same_staff → other_staff → mixed; встык раньше with_gap; внутри — по дате.
  const rank = { same_staff: 0, other_staff: 1, mixed: 2 };
  variants.sort((x, y) =>
    (rank[x.type] - rank[y.type])
    || ((x.with_gap ? 1 : 0) - (y.with_gap ? 1 : 0))
    || x.date.localeCompare(y.date));

  const shortlist = variants.slice(0, MAX_VARIANTS);

  // option_id на каждый старт + кэш цепочек: пациент выбирает вариант →
  // модель зовёт book_chain(option_id), НЕ переписывая chain руками.
  let optN = 0;
  const offerMap = {};
  for (const v of shortlist) {
    for (const st of v.starts) {
      st.option_id = `o${++optN}`;
      offerMap[st.option_id] = {
        chain: st.chain,
        booking_mode: st.booking_mode,
        anchored: !!v.anchored,
      };
    }
  }
  if (ctx && ctx.dialogKey) seqOffers.remember(salonId, ctx.dialogKey, offerMap, { nowMs });

  const out = { requested_date: date, variants: shortlist, performers_by_service: performersByService };
  if (scheduleFailures) out.schedule_degraded = true;
  if (preferredCannot.length) out.preferred_staff_cannot = preferredCannot;

  if (anchor) {
    out.anchored = true;
    if (!shortlist.length) {
      out.reason = 'no_slot_after_booked';
      out.hint = 'В тот же день ПОСЛЕ уже записанной процедуры свободного времени для следующих услуг не нашлось. ' +
        'НЕ переноси записанную процедуру. Предложи добавляемую услугу отдельным визитом в другой день ' +
        '(get_available_slots) или другой удобный период.';
    } else {
      out.hint = 'Первая услуга каждого chain УЖЕ записана (already_booked) — её НЕ переноси. ' +
        'Пациент выбрал вариант — оформляй ОДНИМ вызовом book_chain с option_id этого старта (уже записанную услугу ' +
        'инструмент не тронет). Время бери ТОЛЬКО из starts. Если gap_minutes>0 — честно назови ' +
        'перерыв. Если preferred_staff_cannot непуст — скажи, что записанный мастер эти услуги не ведёт, и назови ' +
        'исполнителей из performers_by_service.';
    }
    if (scheduleFailures) out.hint += ' ВНИМАНИЕ: часть графиков получить не удалось (schedule_degraded) — список может быть неполным.';
    return out;
  }

  if (!shortlist.length) {
    out.reason = 'no_combo_in_horizon';
    out.hint = `За ${HORIZON_DAYS + 1} дней с ${date} собрать эти услуги в один визит не получилось. ` +
      'ЧЕСТНО скажи это пациенту и предложи: процедуры отдельными визитами (get_available_slots по каждой) ' +
      'или другой удобный период. Эскалация — крайняя мера.';
    if (scheduleFailures) {
      out.hint += ' ВНИМАНИЕ: часть графиков получить не удалось (schedule_degraded) — НЕ утверждай уверенно, ' +
        'что времени нет совсем; предложи повторить позже или уточнить у администратора.';
    }
  } else {
    out.hint = 'Предлагай варианты в порядке списка (приоритет — сохранить всё у текущего мастера) и ' +
      'называй мастера каждой процедуры. Время предлагай ТОЛЬКО из starts. Пациент выбрал вариант — оформляй ' +
      'ОДНИМ вызовом book_chain с option_id этого старта, НЕ через create_booking вручную. Вариант with_gap подавай честно, ' +
      'сразу называя перерыв gap_minutes. Если preferred_staff_cannot непуст — скажи, что текущий мастер ' +
      'эти процедуры не выполняет, и назови исполнителей из performers_by_service.';
    if (scheduleFailures) {
      out.hint += ' ВНИМАНИЕ: часть графиков получить не удалось (schedule_degraded) — список вариантов ' +
        'может быть неполным, не утверждай, что других вариантов нет.';
    }
  }
  return out;
}

module.exports = { schema, run };
