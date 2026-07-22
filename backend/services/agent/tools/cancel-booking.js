'use strict';

const bookingModify = require('../booking-modify');
const identity = require('../identity');
const listServices = require('./list-services');

const schema = {
  name: 'cancel_booking',
  description: 'ОТМЕНИТЬ запись пациента. Вызывать ТОЛЬКО после того, как пациент подтвердил ' +
    'отмену И отказался от переноса (сначала всегда предлагай перенос — см. сценарий отмены/переноса ' +
    'в промпте). record_id бери из list_client_bookings — НИКОГДА не придумывай.',
  input_schema: {
    type: 'object',
    properties: {
      record_id: { type: 'integer', description: 'YClients-id записи из list_client_bookings.' },
    },
    required: ['record_id'],
    additionalProperties: false,
  },
};

// Услуга-флаг «Запрет на отправку» глушит уведомления YClients по записи.
// Ищем её в каталоге по нормализованному названию (отдельной настройки нет).
const NO_NOTIFY_TITLE = 'запрет на отправку';
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function findNoNotifyServiceId(salonId) {
  let catalog = null;
  try { catalog = await listServices.run(salonId); } catch (_) { return null; }
  const svc = (catalog && Array.isArray(catalog.services) ? catalog.services : [])
    .find(s => norm(s.title).includes(NO_NOTIFY_TITLE));
  return svc ? svc.yc_id : null;
}

async function run(salonId, input, ctx = {}) {
  const recordId = input && input.record_id;
  if (!recordId) return { invalid_args: true, error: 'Нужен record_id из list_client_bookings.' };

  const expectedYcClientId = await identity.resolveYclientsClientId(salonId, ctx.clientPhone);
  const noNotifyServiceId = await findNoNotifyServiceId(salonId);

  const res = await bookingModify.cancelBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || ctx.clientPhone,
    recordId,
    expectedYcClientId,
    noNotifyServiceId,
  });
  if (!res.ok) return { error: res.error, foreign: res.foreign };
  return {
    cancelled: true,
    record_id: res.record_id,
    already: !!res.already,
    // услуга «Запрет на отправку» не найдена в каталоге → уведомления могли не заглушиться
    no_notify_warning: !noNotifyServiceId,
  };
}

module.exports = { schema, run };
