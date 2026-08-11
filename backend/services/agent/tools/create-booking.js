'use strict';

const booking = require('../booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const listServices = require('./list-services');
const getSlots = require('./get-available-slots');
const leadTime = require('../lead-time');
const tpLimit = require('../third-party-limit');
const genericGuard = require('../generic-booking-guard');

// Отказ YClients именно по времени старта («Выбранное время недоступно…»,
// «мастер занят…»), а не по услуге/токену/клиенту. Только на нём есть смысл
// перезапрашивать слоты.
const TIME_UNAVAILABLE_RE = /недоступн|занят|пересек|overlap|busy/i;

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
      patient_named_service: { type: 'boolean', description: 'Ставь true, ТОЛЬКО если пациент ' +
        'САМ явно назвал этот конкретный препарат/филлер в переписке (в том числе своими словами ' +
        'или кириллицей). Без явного упоминания пациентом — не ставь.' },
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
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  // Анти-абьюз (аудит 2026-08-01): client_phone принимает произвольный номер
  // («запись другого человека») — без лимита один диалог насоздаёт записей на
  // чужие номера. Не больше LIMIT РАЗНЫХ посторонних номеров за сутки; повторная
  // запись на уже записанный номер (цепочка услуг гостю) проходит всегда.
  const thirdParty = tpLimit.isThirdParty(input && input.client_phone, ctx.clientPhone);
  if (thirdParty && !tpLimit.allowed(salonId, ctx.dialogKey || clientPhone, clientPhone, nowMs)) {
    return {
      third_party_limit: true,
      error: 'Оформить запись ещё на один новый номер из этого диалога сегодня нельзя. ' +
        'Предложи, чтобы гость написал нам сам со своего номера, или переведи на администратора (escalate_to_operator).',
    };
  }
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
    // Обобщённая услуга по умолчанию (правило «ПРЕПАРАТ/ФИЛЛЕР НЕ УТОЧНЯЕМ»,
    // инцидент 2026-07-31 «Revi Silk» вместо «Биоревитализации»): запись на
    // конкретный препарат, латинского названия которого нет в сообщениях
    // пациента, детерминированно переспрашивается — hint-ответ, как too_soon.
    if (!input.patient_named_service) {
      const g = genericGuard.check({
        title: svc.title, categoryPath: svc.category_path,
        patientText: ctx.patientText, services: catalog.services,
      });
      if (g) {
        return {
          generic_service_hint: true,
          error: `Пациент не называл препарат (${g.brands.join(' ')}). По правилу «ПРЕПАРАТ/ФИЛЛЕР НЕ УТОЧНЯЕМ» ` +
            `оформляй обобщённую услугу «${g.genericTitle}» (service_yc_id=${g.genericYcId}) — препарат подберёт врач на визите. ` +
            'Если пациент явно называл именно этот препарат своими словами — повтори вызов с patient_named_service:true.',
        };
      }
    }
  }
  // Минимальный срок до визита (день в день +2ч, вечером на завтра — с 12:00).
  // Инструменты слотов такие старты уже не выдают, но пациент может назвать
  // раннее время сам, а модель — послушно передать его сюда. Детерминированный
  // отказ до похода в YClients; сообщение — корректирующее, модель предложит
  // допустимое время. Тот же guard срабатывает и внутри book_chain.
  const v = leadTime.violation(leadTime.moscowNow(nowMs), input.datetime);
  if (v) return { too_soon: true, error: leadTime.violationHint(v) };
  const res = await booking.createBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || clientPhone,
    staffYcId: input.staff_yc_id,
    serviceYcId: input.service_yc_id,
    datetime: input.datetime,
    seanceLength: input.seance_length,
    clientPhone,
    clientName,
    comment: input.comment,
  });
  // Лимит тратят только УСПЕШНЫЕ записи (и не дубли): неудачная попытка не должна
  // блокировать честную переигровку с тем же гостем.
  if (thirdParty && res && res.created === true && !res.duplicate) {
    tpLimit.record(salonId, ctx.dialogKey || clientPhone, clientPhone, nowMs);
  }
  return withFreshSlotsOnTimeFailure(salonId, input, ctx, res);
}

// YClients отказал по времени → детерминированно кладём в ответ СВЕЖИЕ реальные
// старты именно этой услуги у этого мастера на эту дату.
// Инцидент 2026-07-31 (диалог 79200255591): на отказ модель сочинила причину
// («окошко на 11:30 только что заняли» — этого никто не сообщал) и предложила
// следующее время из УСТАРЕВШЕЙ выдачи, не перезапросив слоты. Раньше это
// лечилось только правилом в промпте, которое модель наполовину проигнорировала;
// теперь альтернативы приходят в самом результате инструмента.
// Fail-open: перезапрос слотов упал — отдаём исходный ответ как есть.
async function withFreshSlotsOnTimeFailure(salonId, input, ctx, res) {
  if (!res || res.created !== false || res.duplicate) return res;
  if (!TIME_UNAVAILABLE_RE.test(String(res.error || ''))) return res;
  // Мастер обязателен по схеме create_booking, но модель схему нарушить может, а
  // get_available_slots БЕЗ staff_yc_id уходит в мультимастерный режим и отдаёт
  // staff_options вместо slots. Guard прочитал бы пустой slots и заявил пациенту,
  // что «свободных стартов под эту услугу на эту дату больше нет» — то есть
  // детерминированная защита ОТ вранья соврала бы сама. Перезапрашивать нечего:
  // отдаём исходный ответ как есть.
  if (!input || !input.staff_yc_id) return res;
  const date = String(input.datetime || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res;

  let slots = null;
  let offerSlots = null;
  try {
    const fresh = await getSlots.run(salonId, {
      staff_yc_id: input.staff_yc_id, service_yc_id: input.service_yc_id, date,
    }, ctx);
    if (fresh && Array.isArray(fresh.slots)) slots = fresh.slots;
    if (fresh && Array.isArray(fresh.offer_slots)) offerSlots = fresh.offer_slots;
  } catch (_) { /* fail-open: подсказка без списка всё равно полезнее исходной ошибки */ }

  const out = { ...res, slot_unavailable: true };
  if (slots) out.available_slots = slots;
  // Плотная запись (инцидент 2026-08-06): это тот же getSlots.run, что и в
  // обычной выдаче, и он так же ранжирует время по занятости мастера — не
  // подмешать offer_slots сюда значило бы, что ровно в момент повторного
  // предложения (пациенту уже один раз отказали) плотность отключается и
  // Мила снова тянет самое раннее время из available_slots. Полный список
  // остаётся запасным путём — на случай, если пациент попросит другое время.
  if (offerSlots && offerSlots.length) out.offer_slots = offerSlots;
  out.error = slots && slots.length
    ? (offerSlots && offerSlots.length
        ? 'Записать на это время не удалось. Причина неизвестна — НЕ выдумывай её и не утверждай ' +
          'пациенту, что слот «только что заняли». Извинись нейтрально («к сожалению, это время уже ' +
          'недоступно») и предложи время ДОСЛОВНО из offer_slots — это уже подобранные 1–2 времени; ' +
          'полный available_slots бери, только если пациент сам попросит другое время.'
        : 'Записать на это время не удалось. Причина неизвестна — НЕ выдумывай её и не утверждай ' +
          'пациенту, что слот «только что заняли». Извинись нейтрально («к сожалению, это время уже ' +
          'недоступно») и предложи время ТОЛЬКО из available_slots — это свежие реально свободные ' +
          'старты для этой услуги и этого мастера на ту же дату.')
    : 'Записать на это время не удалось, и свободных стартов под эту услугу на эту дату больше нет. ' +
      'НЕ выдумывай причину и не утверждай, что слот «только что заняли». Извинись нейтрально и ' +
      'предложи другой день (get_available_slots на другую дату) или другого мастера, ' +
      'который выполняет эту услугу.';
  return out;
}

module.exports = { schema, run };
