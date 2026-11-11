'use strict';

const bookingModify = require('../booking-modify');
const identity = require('../identity');
const leadTime = require('../lead-time');
const slotEvidence = require('../slot-evidence');
const writeGuard = require('../booking-write-guard');
const getSlots = require('./get-available-slots');
const { createLogger } = require('../../../logger');
const logger = createLogger('AgentReschedule');

// Отказ YClients именно по времени (тот же признак, что у create_booking).
const TIME_UNAVAILABLE_RE = /недоступн|занят|пересек|overlap|busy/i;

const schema = {
  name: 'reschedule_booking',
  description: 'ПЕРЕНЕСТИ запись пациента на новое время. record_id бери из list_client_bookings; ' +
    'datetime — ТОЧНУЮ строку из get_available_slots.datetime (…+03:00), не собирай вручную. ' +
    'Вызывать ТОЛЬКО после того, как пациент подтвердил новый слот; согласие оцениваешь ты сама и ' +
    'передаёшь в patient_confirmed. По умолчанию услуга и мастер ' +
    'сохраняются (staff_yc_id передавай, только если пациент меняет мастера).',
  input_schema: {
    type: 'object',
    properties: {
      record_id:     { type: 'integer', description: 'YClients-id записи из list_client_bookings.' },
      datetime:      { type: 'string',  description: 'ISO datetime нового слота из get_available_slots.datetime (с +03:00).' },
      staff_yc_id:   { type: 'integer', description: 'Новый мастер (необязательно; по умолчанию прежний).' },
      seance_length: { type: 'integer', description: 'Не передавай: длительность записи при переносе сохраняется.' },
      patient_confirmed: { type: 'boolean', description: 'true — пациент в переписке явно согласился перенести запись именно на это время (любыми словами: «да», «переносим», «подходит», сам назвал это время). false — согласия ещё не было, или пациент только спрашивает, сомневается, меняет условия.' },
    },
    required: ['record_id', 'datetime', 'patient_confirmed'],
    additionalProperties: false,
  },
};

async function run(salonId, input, ctx = {}) {
  const recordId = input && input.record_id;
  const datetime = input && input.datetime;
  if (!recordId || !datetime) return { invalid_args: true, error: 'Нужны record_id и datetime.' };

  // ДВА гейта до похода в YClients (инцидент 2026-09-19, 79651442032: перенос на
  // выдуманные 10:00/11:00 без единого слот-вызова и без согласия пациентки):
  //  (1) время обязано быть в выдаче слот-инструмента этого хода или свежего
  //      журнала (ctx.slotEvidence, см. slot-evidence.js);
  //  (2) согласие пациента: его определяет МОДЕЛЬ (patient_confirmed), код
  //      сверяет лишь, что новое время звучало в переписке цифрами
  //      (инцидент 2026-09-30, см. booking-write-guard.rescheduleRejection).
  // Оба — hint-ответы (invalid_args), а не провал записи: оркестратор их не
  // считает bookingErrored, модель делает пропущенный шаг и повторяет вызов.
  // Без контекста согласия перенос запрещён. Для цепочки код передаёт
  // привязанное к конкретному record_id/слоту подтверждение, не аргумент модели.
  if (ctx.slotEvidence && !ctx.slotEvidence.has(datetime, { staffYcId: input.staff_yc_id })) {
    return { unverified_slot: true, invalid_args: true,
      error: slotEvidence.unverifiedSlotHint(datetime, { reschedule: true }) };
  }

  // Минимальный срок до визита действует и на перенос: перенести запись на
  // «через час» или поздним вечером на завтра до 12:00 нельзя — специалист
  // выходит в клинику под запись и не успеет (то же правило, что в create_booking).
  const v = leadTime.violation(leadTime.moscowNow((ctx && ctx.nowMs) || Date.now()), datetime);
  if (v) return { too_soon: true, error: leadTime.violationHint(v) };

  const consentRejection = writeGuard.rescheduleRejection(input, ctx);
  if (consentRejection) return consentRejection;
  if (writeGuard.strictMismatch(input, ctx)) {
    logger.info(`dialog ${ctx.dialogKey || ctx.clientPhone}: перенос ${recordId} на ${datetime} — согласие по флагу модели, строгая проверка текста отказала бы`);
  }

  const expectedYcClientId = await identity.resolveYclientsClientId(salonId, ctx.clientPhone);
  // Fail-closed: без подтверждённого клиента перенос не делаем (гейт
  // принадлежности в booking-modify иначе открывается на выдуманный record_id).
  if (!expectedYcClientId) {
    return { unverified: true,
      error: 'Не удалось подтвердить, что запись принадлежит этому пациенту. ' +
        'Уточни номер телефона или переведи диалог на администратора.' };
  }
  const res = await bookingModify.rescheduleBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || ctx.clientPhone,
    recordId,
    expectedYcClientId,
    datetime,
    staffYcId: input.staff_yc_id,
    seanceLength: input.seance_length,
    slotEvidence: ctx.slotEvidence,
    expectedServiceYcIds: ctx.expectedServiceYcIds,
  });
  if (!res.ok) {
    if (res.wrongService) return { invalid_args: true, wrong_service: true, error: res.error };
    if (res.shortSlot) return { invalid_args: true, short_slot: true, error: res.error };
    if (res.staffMismatch) return { invalid_args: true, staff_mismatch: true, error: res.error };
    return withFreshSlotsOnTimeFailure(salonId, datetime, ctx, res);
  }
  return { rescheduled: true, record_id: res.record_id, datetime: res.datetime };
}

// YClients отказал по времени → свежие реальные старты ПОД ЭТУ запись (её
// мастер, услуги и полная длительность) на ту же дату — паритет с
// create_booking.withFreshSlotsOnTimeFailure. Инцидент 2026-11-11
// (79166123348): на «Выбранное время недоступно» модель извинилась и перевела
// диалог на администратора, хотя у того же врача в тот же день было 15:15–15:45.
// Fail-open: перезапрос упал или данных записи нет — исходная ошибка как есть.
async function withFreshSlotsOnTimeFailure(salonId, datetime, ctx, res) {
  const base = { error: res.error, foreign: res.foreign };
  const rec = res.record;
  if (!rec || !TIME_UNAVAILABLE_RE.test(String(res.error || ''))) return base;
  const date = String(datetime || '').slice(0, 10);
  const serviceId = (rec.service_ids || [])[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !rec.staff_id || !serviceId) return base;
  let fresh = null;
  try {
    fresh = await getSlots.run(salonId, { staff_yc_id: rec.staff_id, service_yc_id: serviceId, date }, {
      ...ctx,
      recordLengthOverride: { record_id: rec.id, seance_length: rec.seance_length, service_yc_ids: rec.service_ids },
    });
  } catch (_) { fresh = null; }
  if (!fresh || !Array.isArray(fresh.slots)) return base;
  const out = { ...base, slot_unavailable: true, staff_yc_id: rec.staff_id, service_yc_id: serviceId,
    available_slots: fresh.slots };
  if (Array.isArray(fresh.offer_slots) && fresh.offer_slots.length) out.offer_slots = fresh.offer_slots;
  out.error = fresh.slots.length
    ? 'Перенести на это время не удалось — вся запись в него не помещается или время уже недоступно. ' +
      'Запись НЕ перенесена, но это не повод передавать диалог администратору. Причину НЕ выдумывай. ' +
      'Нейтрально извинись и сразу предложи время ДОСЛОВНО из ' + (out.offer_slots ? 'offer_slots' : 'available_slots') +
      ' — это свежие старты, куда помещается ВСЯ запись у того же специалиста на ту же дату; полный ' +
      'available_slots бери, только если пациент попросит другое время. После его «да» повтори reschedule_booking.'
    : 'Перенести на это время не удалось, и в этот день у специалиста больше нет окна, куда поместилась бы ' +
      'ВСЯ запись. Запись НЕ перенесена. Причину НЕ выдумывай; предложи пациенту другой день ' +
      '(get_available_dates / get_available_slots с record_id).';
  return out;
}

// Hint-ответы инструмента: предрешённые подсказки модели, НЕ провал переноса
// (оркестратор не ставит по ним bookingErrored). Настоящий провал — error без
// этих флагов (отказ YClients, запись не найдена, чужая запись).
function isHintResult(res) {
  return !!(res && (res.invalid_args || res.too_soon || res.unverified_slot || res.needs_confirmation
    || res.wrong_service || res.short_slot));
}

module.exports = { schema, run, isHintResult };
