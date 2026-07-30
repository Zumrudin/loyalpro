'use strict';

// ── Оформление выбранного варианта get_sequential_slots ОДНИМ вызовом. ──────
// Раньше модель сама интерпретировала booking_mode/anchored и вызывала
// create_booking + modify_booking_services в правильном порядке — самая
// ошибкоопасная многошаговая write-оркестровка промпта. Теперь это код.
// Переиспользуем хендлеры create-booking/modify-booking-services: все их
// guard'ы (фильтр услуг, проверка id, подстановка телефона, идемпотентность)
// работают и здесь.
// ВАЖНО: offer.chain — разделяемая ссылка с кэшем sequential-offers (take не
// клонирует): цепочку и её элементы НЕ мутируем.

const createBk = require('./create-booking');
const modifySvc = require('./modify-booking-services');
const offers = require('../sequential-offers');

const schema = {
  name: 'book_chain',
  description: 'ОФОРМИТЬ выбранный пациентом вариант из get_sequential_slots одним вызовом. ' +
    'Передай option_id выбранного старта — инструмент сам создаст все записи цепочки правильным ' +
    'способом (одной записью или отдельными, уже записанную услугу не тронет). Вызывать ТОЛЬКО ' +
    'после явного согласия пациента на конкретный вариант. НЕ оформляй цепочку вручную через ' +
    'create_booking. Если вернул option_expired — вызови get_sequential_slots заново и предложи ' +
    'свежие варианты.',
  input_schema: {
    type: 'object',
    properties: {
      option_id: { type: 'string', description: 'option_id выбранного старта из последнего ответа get_sequential_slots.' },
      comment: { type: 'string', description: 'ОБЯЗАТЕЛЬНО: краткий контекст обращения для администратора (как в create_booking).' },
      client_phone: { type: 'string', description: 'Телефон, если записываем другого человека (иначе не передавай — подставится сам).' },
      client_name: { type: 'string', description: 'Имя пациента, если известно.' },
    },
    required: ['option_id'],
    additionalProperties: false,
  },
};

// deps — для тестов; по умолчанию реальные хендлеры инструментов.
async function run(salonId, input, ctx = {}, deps = {}) {
  const createBooking = deps.createBooking || createBk.run;
  const modifyServices = deps.modifyServices || modifySvc.run;

  const offer = offers.take(salonId, ctx.dialogKey, input && input.option_id);
  if (!offer) {
    return {
      option_expired: true,
      error: 'Этот вариант устарел (option_id не найден). Вызови get_sequential_slots заново ' +
        'и предложи пациенту свежие варианты — время могло измениться.',
    };
  }

  const common = {
    comment: input.comment,
    client_phone: input.client_phone,
    client_name: input.client_name,
  };
  // Якорный режим: первая услуга уже записана — её не создаём и не двигаем.
  const items = (offer.chain || []).filter(l => !l.already_booked);
  if (!items.length) return { error: 'В выбранном варианте нет услуг для оформления.' };

  const bookOne = (l) => createBooking(salonId, {
    staff_yc_id: l.staff_yc_id,
    service_yc_id: l.service_yc_id,
    datetime: l.datetime,
    seance_length: l.seance_length,
    ...common,
  }, ctx);

  const records = [];
  const fail = (failedLink, error) => ({
    booked_all: false,
    partial: records.length > 0,
    records,
    failed_at: failedLink.service_title,
    error,
    hint: records.length
      ? 'Часть записей уже создана (records) — ЧЕСТНО скажи пациенту, что оформлено, а что нет; ' +
        'несостоявшиеся услуги предложи отдельным визитом (get_available_slots) или переведи на администратора.'
      : 'Ничего не оформлено. Вызови get_sequential_slots заново и предложи свежие варианты, ' +
        'либо предложи услуги отдельными визитами.',
  });

  if (offer.booking_mode === 'single_record') {
    // Один мастер, без перерыва: одна запись, услуги добавляются в неё.
    const [first, ...rest] = items;
    const r1 = await bookOne(first);
    if (!r1 || !r1.created) return fail(first, (r1 && r1.error) || 'запись не создана');
    records.push({ record_id: r1.record_id, service_title: first.service_title, datetime: first.datetime });
    if (rest.length) {
      const r2 = await modifyServices(salonId, {
        record_id: r1.record_id,
        add_service_yc_ids: rest.map(l => l.service_yc_id),
      }, ctx);
      if (!r2 || !r2.modified) return fail(rest[0], (r2 && r2.error) || 'услуги не добавились в запись');
      records[0].services_count = r2.services_count;
    }
    return { booked_all: true, records };
  }

  // separate_records: отдельная запись на каждый шаг (разные мастера или перерыв —
  // схлопывать нельзя, зазор потерялся бы; см. buildVariant в get-sequential-slots).
  for (const l of items) {
    const r = await bookOne(l);
    if (!r || !r.created) return fail(l, (r && r.error) || 'запись не создана');
    records.push({ record_id: r.record_id, service_title: l.service_title, datetime: l.datetime });
  }
  return { booked_all: true, records };
}

module.exports = { schema, run };
