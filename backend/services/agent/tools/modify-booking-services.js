'use strict';

const bookingModify = require('../booking-modify');
const identity = require('../identity');

const schema = {
  name: 'modify_booking_services',
  description: 'ДОБАВИТЬ или УБРАТЬ услуги в существующей записи пациента (без смены времени). ' +
    'record_id бери из list_client_bookings; yc_id услуг — из каталога услуг. Вызывать ТОЛЬКО ' +
    'после подтверждения пациентом, какую услугу добавить/убрать. Общая длительность визита ' +
    'пересчитывается автоматически. Если новая длительность налезает на следующую запись — ' +
    'инструмент вернёт overlaps: НЕ обещай, предложи другое время/день или переведи на администратора. ' +
    'Если убрать нужно последнюю услугу (removed_all) — предложи отменить визит (cancel_booking).',
  input_schema: {
    type: 'object',
    properties: {
      record_id: { type: 'integer', description: 'YClients-id записи из list_client_bookings.' },
      add_service_yc_ids: {
        type: 'array', items: { type: 'integer' },
        description: 'yc_id услуг для ДОБАВЛЕНИЯ (из каталога услуг, мастер записи должен их выполнять).',
      },
      remove_service_yc_ids: {
        type: 'array', items: { type: 'integer' },
        description: 'yc_id услуг для УДАЛЕНИЯ из записи.',
      },
    },
    required: ['record_id'],
    additionalProperties: false,
  },
};

async function run(salonId, input, ctx = {}) {
  const recordId = input && input.record_id;
  const add = (input && input.add_service_yc_ids) || [];
  const remove = (input && input.remove_service_yc_ids) || [];
  if (!recordId) return { invalid_args: true, error: 'Нужен record_id из list_client_bookings.' };
  if (!add.length && !remove.length) {
    return { invalid_args: true, error: 'Укажи хотя бы одну услугу в add_service_yc_ids или remove_service_yc_ids.' };
  }

  const expectedYcClientId = await identity.resolveYclientsClientId(salonId, ctx.clientPhone);
  // Fail-closed: без подтверждённого клиента запись не трогаем (гейт принадлежности
  // в booking-modify иначе открывается на выдуманный record_id).
  if (!expectedYcClientId) {
    return { unverified: true,
      error: 'Не удалось подтвердить, что запись принадлежит этому пациенту. ' +
        'Уточни номер телефона или переведи диалог на администратора.' };
  }

  const res = await bookingModify.modifyBookingServices(salonId, {
    dialogKey: ctx.dialogKey || ctx.clientPhone,
    recordId,
    expectedYcClientId,
    addServiceYcIds: add,
    removeServiceYcIds: remove,
  });
  if (!res.ok) {
    return {
      error: res.error,
      foreign: res.foreign,
      overlaps: res.overlaps,
      removed_all: res.removed_all,
      invalid_service: res.invalid_service,
    };
  }
  return { modified: true, record_id: res.record_id, seance_length: res.seance_length,
    services_count: res.services_count };
}

module.exports = { schema, run };
