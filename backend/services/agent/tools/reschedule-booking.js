'use strict';

const bookingModify = require('../booking-modify');
const identity = require('../identity');
const leadTime = require('../lead-time');
const slotEvidence = require('../slot-evidence');
const writeGuard = require('../booking-write-guard');
const { createLogger } = require('../../../logger');
const logger = createLogger('AgentReschedule');

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
      seance_length: { type: 'integer', description: 'Длительность из слота, если известна (необязательно).' },
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
    return { error: res.error, foreign: res.foreign };
  }
  return { rescheduled: true, record_id: res.record_id, datetime: res.datetime };
}

// Hint-ответы инструмента: предрешённые подсказки модели, НЕ провал переноса
// (оркестратор не ставит по ним bookingErrored). Настоящий провал — error без
// этих флагов (отказ YClients, запись не найдена, чужая запись).
function isHintResult(res) {
  return !!(res && (res.invalid_args || res.too_soon || res.unverified_slot || res.needs_confirmation || res.wrong_service));
}

module.exports = { schema, run, isHintResult };
