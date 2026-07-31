'use strict';

const bookingModify = require('../booking-modify');
const identity = require('../identity');
const leadTime = require('../lead-time');

const schema = {
  name: 'reschedule_booking',
  description: 'ПЕРЕНЕСТИ запись пациента на новое время. record_id бери из list_client_bookings; ' +
    'datetime — ТОЧНУЮ строку из get_available_slots.datetime (…+03:00), не собирай вручную. ' +
    'Вызывать ТОЛЬКО после того, как пациент подтвердил новый слот. По умолчанию услуга и мастер ' +
    'сохраняются (staff_yc_id передавай, только если пациент меняет мастера).',
  input_schema: {
    type: 'object',
    properties: {
      record_id:     { type: 'integer', description: 'YClients-id записи из list_client_bookings.' },
      datetime:      { type: 'string',  description: 'ISO datetime нового слота из get_available_slots.datetime (с +03:00).' },
      staff_yc_id:   { type: 'integer', description: 'Новый мастер (необязательно; по умолчанию прежний).' },
      seance_length: { type: 'integer', description: 'Длительность из слота, если известна (необязательно).' },
    },
    required: ['record_id', 'datetime'],
    additionalProperties: false,
  },
};

async function run(salonId, input, ctx = {}) {
  const recordId = input && input.record_id;
  const datetime = input && input.datetime;
  if (!recordId || !datetime) return { invalid_args: true, error: 'Нужны record_id и datetime.' };

  // Минимальный срок до визита действует и на перенос: перенести запись на
  // «через час» или поздним вечером на завтра до 12:00 нельзя — специалист
  // выходит в клинику под запись и не успеет (то же правило, что в create_booking).
  const v = leadTime.violation(leadTime.moscowNow((ctx && ctx.nowMs) || Date.now()), datetime);
  if (v) return { too_soon: true, error: leadTime.violationHint(v) };

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
  });
  if (!res.ok) return { error: res.error, foreign: res.foreign };
  return { rescheduled: true, record_id: res.record_id, datetime: res.datetime };
}

module.exports = { schema, run };
