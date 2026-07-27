'use strict';

const { db } = require('../../../db');
const { ycGetStaffSeances } = require('../../yclients-booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const staffGuard = require('../staff-service-guard');
const eq = require('../equipment');
const eqContext = require('../equipment-context');

// ── Общее время для НЕСКОЛЬКИХ гостей одновременно. ─────────────────────────
// Отдельный инструмент, а не «позови get_available_slots дважды и пересеки»:
// пересечение окон и распределение аппаратов — интервальная арифметика, на
// которой модель ошибается тем чаще, чем больше окон. Здесь она считается в
// коде и один вызов заменяет 2–4 вызова слотов.

const STEP_MIN = 30;
const DEFAULT_DURATION_MIN = 60;   // если YClients не отдал duration услуги

const schema = {
  name: 'get_parallel_slots',
  description: 'Подобрать время, когда НЕСКОЛЬКО гостей смогут пройти процедуры ОДНОВРЕМЕННО ' +
    '(например, клиент и его подруга/дочь). Учитывает графики всех мастеров И занятость ' +
    'аппаратов. Вызывать, когда просят записать двоих «параллельно», «вместе», «в одно время». ' +
    'Нужны yc_id услуги и мастера для каждого гостя (из каталога услуг). Дата YYYY-MM-DD.',
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Дата YYYY-MM-DD.' },
      guests: {
        type: 'array',
        description: 'По одному элементу на гостя (минимум 2).',
        items: {
          type: 'object',
          properties: {
            service_yc_id: { type: 'integer', description: 'YClients-id услуги.' },
            staff_yc_id:   { type: 'integer', description: 'YClients-id мастера.' },
          },
          required: ['service_yc_id', 'staff_yc_id'],
          additionalProperties: false,
        },
      },
    },
    required: ['date', 'guests'],
    additionalProperties: false,
  },
};

async function run(salonId, input, ctx = {}) {
  const date = input && input.date;
  const guests = (input && Array.isArray(input.guests)) ? input.guests : [];
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  if (!date || guests.length < 2) {
    return { error: 'Нужны date (YYYY-MM-DD) и минимум два гостя в guests.' };
  }

  const salon = await db.oneOrNone(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };

  // Скрытые услуги/пары не подбираем — так же, как в одиночных слотах.
  const filter = await settings.loadServiceFilterSafe(salonId);
  for (const g of guests) {
    if (!svcFilter.isBookable(filter, g.service_yc_id, g.staff_yc_id)) {
      return { starts: [], filtered: true };
    }
  }

  // Один мастер не ведёт двоих одновременно. Без этой проверки окна мастера
  // пересеклись бы сами с собой и инструмент бодро предложил бы время.
  const staffIds = guests.map(g => String(g.staff_yc_id));
  if (new Set(staffIds).size !== staffIds.length) {
    return {
      starts: [], impossible: true, reason: 'same_staff',
      hint: 'Гостям назначен один и тот же мастер — одновременно он их не примет. ' +
        'Подбери разных мастеров на эти услуги и вызови инструмент заново.',
    };
  }

  // Предпроверка по каждому гостю: назначенный мастер должен реально выполнять свою
  // услугу (график/кресло к этому слепы). Иначе подберём общее окно у мастера,
  // который процедуру не делает, и упрёмся уже в create_booking.
  for (let i = 0; i < guests.length; i++) {
    const g = guests[i];
    const chk = await staffGuard.checkStaffPerformsService(salonId, g.service_yc_id, g.staff_yc_id);
    if (!chk.unknown && !chk.ok) {
      const who = chk.performers.length ? ` Эту услугу выполняют: ${chk.performers.join(', ')}.` : '';
      return {
        starts: [], staff_mismatch: true, guest_index: i,
        hint: 'Одному из гостей назначен мастер, который его услугу не выполняет. ' +
          'Подбери профильного мастера из каталога услуг и вызови инструмент заново.' + who,
      };
    }
  }

  const eqCtx = await eqContext.loadEquipmentContext(salon, date);

  // Заявка на гостя: окна его мастера + длительность услуги + нужные аппараты.
  const entries = [];
  for (const g of guests) {
    let seances;
    try {
      seances = await ycGetStaffSeances(salon, g.staff_yc_id, date);
    } catch (e) {
      return { error: `Не удалось получить график мастера: ${e.message}` };
    }
    const ranges = eq.mergeRanges(
      (Array.isArray(seances) ? seances : [])
        .filter(s => s && s.is_free)
        .map(s => ({ start: eq.toMin(s.time), end: eq.toMin(s.time) + 5 })));
    entries.push({
      ranges,
      durationMin: eqContext.durationMin(eqCtx, g.service_yc_id) || DEFAULT_DURATION_MIN,
      instances: eqContext.instancesFor(eqCtx, g.service_yc_id),
      service_yc_id: g.service_yc_id,
      staff_yc_id: g.staff_yc_id,
    });
  }

  // Один аппарат на двоих — время подбирать бессмысленно, параллель невозможна
  // в принципе. Отдаём явную причину, чтобы агент предложил ПОСЛЕДОВАТЕЛЬНО, а
  // не эскалировал и не выдумывал время.
  const conflict = eq.hardResourceConflict(entries);
  if (conflict) {
    const titles = (eqCtx.resources || [])
      .filter(r => (r.instances || []).some(i => conflict.includes(String(i.id))))
      .map(r => r.title);
    return {
      starts: [],
      impossible: true,
      reason: 'shared_equipment',
      equipment: titles,
      hint: 'Эти процедуры делаются на одном аппарате, параллельно их провести нельзя. ' +
        'Предложи гостям пройти процедуры одну за другой и подбери последовательное время.',
    };
  }

  const starts = eq.dropPastStarts(
    eq.parallelStarts(entries, { step: STEP_MIN, busy: eqCtx.busy }),
    date, moscowNow(nowMs));

  if (!starts.length) {
    return {
      starts: [], impossible: true, reason: 'no_common_window',
      hint: 'Общего окна в этот день нет. Предложи другой день или последовательную запись.',
    };
  }

  return {
    date,
    starts: starts.map(t => ({
      time: eq.toHHMM(t),
      guests: entries.map(e => ({
        service_yc_id: e.service_yc_id,
        staff_yc_id: e.staff_yc_id,
        datetime: `${date}T${eq.toHHMM(t)}:00+03:00`,
        seance_length: e.durationMin * 60,
      })),
    })),
  };
}

// Текущий момент по Москве (для отсечения прошедших стартов).
function moscowNow(ms) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const [h, m] = hm.split(':').map(Number);
  return { date, minutes: h * 60 + m };
}

module.exports = { schema, run };
