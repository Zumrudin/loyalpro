'use strict';

const booking = require('../booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');

const schema = {
  name: 'create_booking',
  description: 'СОЗДАТЬ запись клиента в YClients. Вызывать ТОЛЬКО после того, как ' +
    'клиент явно подтвердил детали (услуга, мастер, дата/время) текстом. ' +
    'Перед вызовом обязательно повтори детали клиенту и получи согласие. ' +
    'Телефон клиента берётся из диалога; передавай его в client_phone.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера.' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги.' },
      datetime:      { type: 'string',  description: 'ISO datetime слота — передавай ТОЧНУЮ строку из ' +
        'get_available_slots.datetime вместе с часовым поясом (…+03:00), не собирай её вручную.' },
      seance_length: { type: 'integer', description: 'Длительность в секундах (из слота).' },
      client_phone:  { type: 'string',  description: 'Телефон клиента.' },
      client_name:   { type: 'string',  description: 'Имя клиента (если известно).' },
      comment:       { type: 'string',  description: 'ОБЯЗАТЕЛЬНО: краткий контекст обращения для администратора — ' +
        'чем интересовался клиент и важные детали из диалога (напр. «Интересовалась фотоомоложением Lumecca, ' +
        'спрашивала про биоревитализацию и бонусы»). Для параллельной записи добавь пометку про спутника ' +
        '(«подруга Анны, параллельно с записью на 12:00»).' },
    },
    required: ['staff_yc_id', 'service_yc_id', 'datetime', 'client_phone'],
    additionalProperties: false,
  },
};

// ctx.dialogKey прокидывается оркестратором (Фаза 2b).
async function run(salonId, input, ctx = {}) {
  const filter = await settings.loadServiceFilterSafe(salonId);
  if (!svcFilter.isBookable(filter, input.service_yc_id, input.staff_yc_id)) {
    return {
      not_bookable: true,
      error: 'Эта услуга у выбранного мастера сейчас недоступна для записи. ' +
        'Предложи другую услугу или мастера, либо передай оператору.',
    };
  }
  return booking.createBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || input.client_phone,
    staffYcId: input.staff_yc_id,
    serviceYcId: input.service_yc_id,
    datetime: input.datetime,
    seanceLength: input.seance_length,
    clientPhone: input.client_phone,
    clientName: input.client_name,
    comment: input.comment,
  });
}

module.exports = { schema, run };
