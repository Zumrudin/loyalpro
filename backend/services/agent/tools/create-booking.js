'use strict';

const booking = require('../booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const listServices = require('./list-services');

const schema = {
  name: 'create_booking',
  description: 'СОЗДАТЬ запись клиента в YClients. Вызывать ТОЛЬКО после того, как ' +
    'клиент явно подтвердил детали (услуга, мастер, дата/время) текстом. ' +
    'Перед вызовом обязательно повтори детали клиенту и получи согласие. ' +
    'Телефон основного пациента чаще всего уже известен системе (см. блок «Идентификация ' +
    'пациента» в промпте) — тогда client_phone можно НЕ передавать, он подставится сам. ' +
    'client_phone передавай, только если номер собран в диалоге (например номер второго гостя).',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера.' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги.' },
      datetime:      { type: 'string',  description: 'ISO datetime слота — передавай ТОЧНУЮ строку из ' +
        'get_available_slots.datetime вместе с часовым поясом (…+03:00), не собирай её вручную.' },
      seance_length: { type: 'integer', description: 'Длительность в секундах (из слота).' },
      client_phone:  { type: 'string',  description: 'Телефон клиента. Можно не передавать, если номер ' +
        'основного пациента уже известен системе — подставится автоматически.' },
      client_name:   { type: 'string',  description: 'Имя клиента (если известно).' },
      comment:       { type: 'string',  description: 'ОБЯЗАТЕЛЬНО: краткий контекст обращения для администратора — ' +
        'чем интересовался клиент и важные детали из диалога (напр. «Интересовалась фотоомоложением Lumecca, ' +
        'спрашивала про биоревитализацию и бонусы»). Для параллельной записи добавь пометку про спутника ' +
        '(«подруга Анны, параллельно с записью на 12:00»).' },
    },
    required: ['staff_yc_id', 'service_yc_id', 'datetime'],
    additionalProperties: false,
  },
};

// ctx.dialogKey / ctx.clientPhone / ctx.clientName прокидываются оркестратором.
// clientPhone/clientName из ctx — идентификация основного пациента по номеру из
// вебхука: модель не переспрашивает уже известный номер, а инструмент подставляет
// его детерминированно (Flash Lite ненадёжен — на него нельзя перекладывать
// «не забудь номер»). Номер из input (второй гость, собранный в диалоге) приоритетен.
async function run(salonId, input, ctx = {}) {
  const clientPhone = String((input && input.client_phone) || ctx.clientPhone || '').trim();
  if (!clientPhone) {
    return {
      invalid_args: true,
      error: 'Нет номера телефона клиента. Если номер известен из диалога — передай его ' +
        'в client_phone; иначе вежливо запроси номер у клиента и повтори вызов.',
    };
  }
  const clientName = String((input && input.client_name) || ctx.clientName || '').trim() || undefined;
  const filter = await settings.loadServiceFilterSafe(salonId);
  if (!svcFilter.isBookable(filter, input.service_yc_id, input.staff_yc_id)) {
    return {
      not_bookable: true,
      error: 'Эта услуга у выбранного мастера сейчас недоступна для записи. ' +
        'Предложи другую услугу или мастера, либо передай оператору.',
    };
  }
  // Детерминированная защита от ВЫДУМАННЫХ id: услуга и мастер должны реально
  // существовать в каталоге салона, и мастер должен выполнять эту услугу.
  // Flash Lite иногда подставляет несуществующие id → YClients отвечает 404 уже
  // ПОСЛЕ «подтверждения». Ловим до вызова YClients и возвращаем модели
  // корректирующую ошибку, чтобы она взяла точные id из list_services.
  // Fail-open: если каталог недоступен/пуст — не блокируем (иначе при сбое
  // YClients ни одна легитимная запись не пройдёт).
  let catalog = null;
  try { catalog = await listServices.run(salonId); } catch (_) { catalog = null; }
  if (catalog && Array.isArray(catalog.services) && catalog.services.length) {
    const svc = catalog.services.find(s => String(s.yc_id) === String(input.service_yc_id));
    if (!svc) {
      return {
        invalid_args: true,
        error: 'Услуга с таким service_yc_id не найдена в каталоге. Возьми точный ' +
          'service_yc_id из каталога услуг — не придумывай id.',
      };
    }
    const staffOk = (svc.staff || []).some(m => String(m.yc_id) === String(input.staff_yc_id));
    if (!staffOk) {
      return {
        invalid_args: true,
        error: 'Выбранный мастер не выполняет эту услугу (или staff_yc_id неверный). ' +
          'Возьми мастера из поля staff нужной услуги в каталоге услуг.',
      };
    }
  }
  return booking.createBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || clientPhone,
    staffYcId: input.staff_yc_id,
    serviceYcId: input.service_yc_id,
    datetime: input.datetime,
    seanceLength: input.seance_length,
    clientPhone,
    clientName,
    comment: input.comment,
  });
}

module.exports = { schema, run };
