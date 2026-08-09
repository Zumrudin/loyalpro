'use strict';

const providers = require('./providers');
const registryDefault = require('./tools');
const historyDefault = require('./history');
const stateDefault = require('./dialog-state');
const identityDefault = require('./identity');
const config = require('../../config');
const catalogBlockDefault = require('./catalog-block');
const seqOffers = require('./sequential-offers');
const replyGuard = require('./reply-guard');
const greeting = require('./greeting');
const addressGuard = require('./address-guard');
const closing = require('./closing');
const adminHours = require('./admin-hours');
const toolEventsDefault = require('./tool-events');
const toolMemoryDefault = require('./tool-memory');
const listBookingsDefault = require('./tools/list-client-bookings');
const bookingsBlock = require('./bookings-block');
const priceListDefault = require('./price-list-data');
const priceList = require('./price-list');
const { buildSystemPrompt } = require('./system-prompt');
const { stripAllStamps, stripStamp } = require('./transcript-time');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentOrchestrator');

// Защитный лимит tool-use итераций на один ход. Не жадничать: Gemini Flash Lite
// отдаёт tool_calls с ПУСТЫМ content, поэтому упёршийся в лимит ход не оставляет
// ни единой реплики. Мультизапрос («мне пилинг, а дочке фототерапия») легко берёт
// 7–8 вызовов: list_services → list_staff → dates → slots × N.
// В режиме AGENT_CATALOG_IN_PROMPT каталог уже в промпте — типовой ход короче на 1-2 итерации.
const MAX_ITERS = 12;
const MAX_REGEN = 2;   // сколько раз перегенерировать при новом входящем во время прогона

// Пишущие инструменты: их результат нельзя «выбросить» перегенерацией.
const SIDE_EFFECT_TOOLS = new Set([
  'create_booking', 'book_chain', 'cancel_booking', 'reschedule_booking', 'modify_booking_services',
  'escalate_to_operator',
]);

// Инструменты, меняющие запись в YClients. Успешный вызов одного из них —
// единственное, что даёт право отрапортовать «перенесла / отменила / записала».
const WRITE_TOOLS = new Set(['create_booking', 'cancel_booking', 'reschedule_booking', 'modify_booking_services']);

// Инструменты чтения свободного времени. Их вызов ПОСЛЕ провала create_booking —
// сигнал добросовестной переигровки (модель перепроверяет слоты, а не заканчивает
// ход отпиской «секундочку»). Отличает восстановимый провод от зависания.
const SLOT_READ_TOOLS = new Set([
  'get_available_slots', 'get_available_dates', 'get_sequential_slots', 'get_parallel_slots',
]);

// Плотная запись (§8 docs/superpowers/specs/2026-08-06-agent-slot-density-design.md):
// offer_slots появляется в результате get_available_slots в ТРЁХ местах —
// на верхнем уровне, и внутри каждого элемента staff_options[]/alternative_staff[]
// (мультимастерные ветки, у каждого мастера своя плотность). Собираем времена
// ИМЕННО из offer_slots (не из slots рядом) через общий extractTimes — свой
// парсер времени не пишем, только обход вложенности результата.
function collectOfferSlotTimes(result, out) {
  if (!result || typeof result !== 'object') return;
  if (Array.isArray(result.offer_slots)) {
    for (const t of replyGuard.extractTimes(JSON.stringify(result.offer_slots))) out.add(t);
  }
  for (const key of ['staff_options', 'alternative_staff']) {
    if (Array.isArray(result[key])) {
      for (const item of result[key]) collectOfferSlotTimes(item, out);
    }
  }
}

// Реплика содержит конкретное время (HH:MM / HH.MM) — модель предлагает слот.
// Второй (наряду с перепроверкой слотов) признак переигровки после провала записи:
// «это время заняли, могу 15:00 или 16:00» — против пустого «секундочку».
const REPLY_HAS_TIME = /\b([01]?\d|2[0-3])[:.][0-5]\d\b/;

// Утверждение о ВЫПОЛНЕННОМ действии над записью (не намерение). Пилот
// claude-haiku 2026-07-22: модель написала «Готово, перенесла на 14:00», НЕ
// вызвав reschedule_booking, — клиенту ушла ложь. Ловим завершённые формы;
// инфинитивы намерения («перенести», «отменить») НЕ триггерят.
//
// ДЕЙСТВИЕ, которого снимок записей подтвердить не может: перенос (снимок
// показывает время, но не то, что оно менялось) и правка состава услуг (её в
// блоке нет вовсе). Остаётся БЕЗУСЛОВНОЙ ложью без успешного write-инструмента —
// это и есть founding-случай guard'а (claude-haiku «перенесла на 14:00»).
const COMPLETION_CLAIM =
  /(перенесл[аио]|перенёс|перенесен[оа]|запись\s+перенесен|добавил[аи]|добавлен[аоы]|убрал[аи]|убран[аоы])/i;

// СОСТОЯНИЕ записи — двусмысленно по своей природе: это и ложный успех, и
// честный пересказ факта. Разводим по полярности и сверяем со сверенным
// состоянием записей (existsHonest / cancelledHonest ниже).
//  • «вы записаны», «мы записали вас», «запись оформлена/подтверждена» — запись ЕСТЬ;
//  • «отменила», «запись отменена» — записи НЕТ.
// Что изменилось с 26.07 (0fc2296), где «записала вас/отменила» осознанно
// оставили безусловными: тогда единственным источником фактов о записи был
// вызов инструмента, поэтому «не звала инструмент ⇒ выдумала» было верно. С
// 04.08 оркестратор сверяется с CRM САМ каждый ход и кладёт результат в промпт
// блоком «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА» — у модели появился легальный источник
// БЕЗ инструмента, и старая посылка сломалась. Прод 04.08 (79200255591):
// пациент «ту запись уже удалили», Мила честно ответила про отменённую запись —
// guard съел реплику и увёл диалог на администратора.
// Наречие между «вы» и «записаны» перечислено СПИСКОМ, а не «любым словом»:
// шаблон `вы \S+ записаны` поймал бы и «вы НЕ записаны» — правдивый ответ ровно
// в том состоянии (сверка показала пустой список), в котором guard и срабатывает,
// то есть штатная реплика уводила бы диалог на человека. Инцидент 2026-08-06
// (79200255591): «Я вижу, что вы УЖЕ записаны … на 7 августа в 12:00» про
// удалённую запись проходило мимо guard'а и уезжало пациенту.
const BOOKED_STATE_CLAIM = /(вы\s+(?:уже\s+|всё\s+ещё\s+|все\s+ещё\s+|по-прежнему\s+|пока\s+|точно\s+)?записаны|записал[аи]?\s+вас|оформлен[оа]|подтверждена|запись\s+(создан|оформлен|подтвержден))/i;
const CANCELLED_STATE_CLAIM = /(отменил[аи]?|отменен[оа]|запись\s+отменен)/i;

/**
 * Утверждает ли реплика то, чего ход не подтвердил.
 *
 * @param {string} text склеенные реплики хода.
 * @param {{existsHonest: boolean, cancelledHonest: boolean}} proof сверенное
 *   состояние записей: подтверждено ли «запись есть» / «записи нет».
 * @returns {'completion'|'booked'|'cancelled'|null} вид утверждения (null — лжи нет).
 *   Вид нужен не только внутри: диспетчер пишет его в лог, иначе разбор упирается
 *   в «неизвестно, что именно модель заявила».
 */
function detectFalseClaim(text, proof = {}) {
  if (COMPLETION_CLAIM.test(text)) return 'completion';
  if (!proof.existsHonest && BOOKED_STATE_CLAIM.test(text)) return 'booked';
  if (!proof.cancelledHonest && CANCELLED_STATE_CLAIM.test(text)) return 'cancelled';
  return null;
}

// Служебное сообщение корректирующего довызова. Пациент его не видит.
// Формулировка повторяет правило блока «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА»: пропавшая
// запись — ШТАТНАЯ ситуация, надо предложить подобрать время заново.
const FALSE_CLAIM_CORRECTION =
  'СЛУЖЕБНАЯ ПРОВЕРКА (пациент этого не видит): сверка с CRM в начале этого хода ' +
  'показала, что БУДУЩИХ записей у пациента сейчас НЕТ, а твой ответ утверждает ' +
  'обратное — что пациент записан либо что ты перенесла/отменила/изменила запись. ' +
  'Ничего из этого не подтверждено, и инструмент записи в этом ходе не отработал. ' +
  'Перепиши ответ для пациента: не утверждай, что он записан, и не приписывай себе ' +
  'действий с записью. Если запись нужна — спокойно, без версий о причинах, предложи ' +
  'подобрать время заново и спроси, какой день удобен. КОНКРЕТНОЕ ВРЕМЯ В ЭТОМ ОТВЕТЕ ' +
  'НЕ НАЗЫВАЙ: расписание сейчас не проверяется, свободные окошки ты посмотришь ' +
  'следующим сообщением. В ответе — ТОЛЬКО переписанный текст.';

// Дата по Москве для системного промпта «сегодня …». Даём модели ОБЕ формы:
// машинную YYYY-MM-DD (для арифметики относительных дат и сверки с выдачей
// инструментов) и человеческую с днём недели — чтобы модель не путала «завтра»
// с числом (регресс 2026-07-26: 28 июля названо «завтра» при сегодня 26-м).
function todayMoscow() {
  const now = new Date();
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);
  const human = new Intl.DateTimeFormat('ru-RU',
    { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  return `${iso} (${human})`;
}

// HH:MM по Москве (для промпта — чтобы модель не предлагала прошедшее время).
function nowTimeMoscow() {
  return new Intl.DateTimeFormat('ru-RU',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

// Дата+время слота по Москве для детерминированного подтверждения: «27 июля в 19:30».
function formatSlotMoscow(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const date = new Intl.DateTimeFormat('ru-RU',
    { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' }).format(d);
  const time = new Intl.DateTimeFormat('ru-RU',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return { date, time };
}

// Компактная сводка результата инструмента для лога вызовов (Task 13 плана:
// «в логах виден вызов book_chain» — раньше логировались только исключения,
// диагностика поведения агента требовала debug-preload). НИКОГДА не полный
// дамп — результаты несут PII (телефон) и большие каталоги; берём только
// дешёвые решающие поля бронирования + обрезанный текст ошибки, режем общей
// длиной на случай, если в error затесалось что-то длинное.
const LOG_FRAGMENT_CAP = 200;
function summarizeToolResult(result) {
  if (!result || typeof result !== 'object') return '';
  const bits = [];
  if ('record_id' in result) bits.push(`record_id=${result.record_id}`);
  if ('created' in result) bits.push(`created=${result.created}`);
  if ('booked_all' in result) bits.push(`booked_all=${result.booked_all}`);
  if ('partial' in result) bits.push(`partial=${result.partial}`);
  if ('failed_at' in result) bits.push(`failed_at=${result.failed_at}`);
  if ('escalated' in result) bits.push(`escalated=${result.escalated}`);
  if (result.error) bits.push(`error=${String(result.error).slice(0, 80)}`);
  return bits.join(' ').slice(0, LOG_FRAGMENT_CAP);
}

// Аргументы вызова для лога. Разбор инцидента 2026-07-31 (предложила 11:30,
// записать не смогла) уперся в то, что логировались только результаты: по
// логам нельзя было сказать, с какой услугой модель спрашивала слоты. Пишем
// компактные скалярные аргументы БЕЗ PII (телефон/имя/комментарий не логируем).
const LOG_PII_ARGS = new Set(['client_phone', 'client_name', 'comment']);
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const bits = [];
  for (const [k, v] of Object.entries(input)) {
    if (LOG_PII_ARGS.has(k)) continue;
    if (v === null || v === undefined || typeof v === 'object') continue;
    bits.push(`${k}=${String(v).slice(0, 40)}`);
  }
  return bits.join(',').slice(0, LOG_FRAGMENT_CAP);
}

// Детерминированное подтверждение из данных выполненного пишущего инструмента —
// когда запись УЖЕ сделана, а провайдер упал на подтверждающей фразе (и fallback
// внутри провайдера тоже не выжил). Без LLM: правдиво и не зависит от сбоя. Имена
// мастера/услуги в input только как YClients-id — их не реконструируем; для
// create_booking дата+время достаточны, для прочих write-инструментов — общее «Готово».
function buildWriteConfirmation(lastWrite) {
  const input = (lastWrite && lastWrite.input) || {};
  const who = String(input.client_name || '').trim() || 'вас';
  if (lastWrite && lastWrite.tool === 'create_booking' && input.datetime) {
    const slot = formatSlotMoscow(input.datetime);
    if (slot) return `Готово! Записала ${who} на ${slot.date} в ${slot.time} ✅ Будем ждать 🤍`;
  }
  return 'Готово, всё оформила ✅';
}

// Прогнать один ход диалога. Возвращает { replies, escalated, sideEffect }.
//
// Страховка от неожиданного/забытого выхода: явные флаши внутри остаются
// авторитетными (они ставят delivered=false на выброшенном черновике), а этот —
// идемпотентный добор с консервативным вердиктом для выхода, которого мы не
// предусмотрели. Без него любой throw мимо перечисленных мест терял бы журнал
// хода — ровно в том инциденте, ради форензики которого журнал и заводится.
async function runDialog(salonId, dialogKey, opts = {}) {
  const bag = {};
  try { return await runDialogInner(salonId, dialogKey, opts, bag); }
  finally { if (bag.buf) await bag.buf.flush(null); }
}

async function runDialogInner(salonId, dialogKey, opts = {}, bag = {}) {
  const d = opts.deps || {};
  const provider = d.provider || providers.getProvider();
  const history = d.history || historyDefault;
  const state = d.state || stateDefault;
  const identity = d.identity || identityDefault;
  const toolEvents = d.toolEvents || toolEventsDefault;
  const toolMemory = d.toolMemory || toolMemoryDefault;
  const ctx = opts.ctx || {};
  // Одни часы на весь ход: активные варианты стыковки, гейт свежести памяти и
  // toolCtx обязаны видеть одно и то же «сейчас», иначе разъедутся на миллисекунды.
  const nowMs = opts.nowMs || Date.now();

  const dialog = await state.getOrCreate(salonId, dialogKey);
  if (dialog.status === 'escalated') {
    // Диалог уже передан оператору. Бот молчит на все последующие входящие —
    // объявление о переводе было отправлено в ход самой эскалации. Флаг
    // alreadyEscalated отличает это от свежей эскалации, чтобы диспетчер
    // не переотправлял фразу перевода на каждое новое сообщение.
    return { replies: [], escalated: true, alreadyEscalated: true, sideEffect: false };
  }

  // Идентификация по номеру из вебхука (WhatsApp/tdlib присылают телефон). Если
  // канал номер не дал (Telegram Bot/MAX) или БД недоступна — client=null, и агент
  // собирает контакты в диалоге как раньше. Резолвинг не должен ронять ход.
  let client = null;
  if (ctx.phone) {
    try {
      client = await identity.resolveClient(salonId, ctx.phone);
    } catch (e) {
      logger.warn(`dialog ${dialogKey}: не удалось идентифицировать клиента (${e.message}) — работаем без имени`);
      client = null;
    }
  }
  // Два РАЗНЫХ имени, и путать их нельзя:
  //   • clientGivenName — как обращаться в переписке. Только личное имя, без
  //     фамилии и отчества (инцидент 2026-08-04: «Мария Андреевна, …»).
  //   • clientName — ФИО целиком, уходит в карточку записи YClients, где
  //     администратору нужна полная форма.
  const clientName = (client && client.name && String(client.name).trim()) || null;
  const clientGivenName = (client && client.givenName) || null;

  // Каталог услуг в промпте (AGENT_CATALOG_IN_PROMPT). Сбой сборки блока →
  // null → штатный legacy-режим с инструментом list_services (fail-open).
  const cfg = d.config || config;
  let catalogBlock = null;
  if (cfg.AGENT_CATALOG_IN_PROMPT) {
    try {
      catalogBlock = await (d.catalogBlock || catalogBlockDefault).buildSafe(salonId);
    } catch (e) {
      logger.warn(`dialog ${dialogKey}: не собрать каталог для промпта (${e.message}) — legacy-режим`);
      catalogBlock = null;
    }
  }
  const registry = d.registry || (catalogBlock ? registryDefault.catalogMode : registryDefault);

  // Прайс-листы в картинках → кэшируемый префикс промпта + индекс для инструмента.
  // Сбой сборки не имеет права ронять ход: блока нет, ключей у модели нет,
  // send_price_list вернёт ошибку-подсказку (fail-open, как у каталога).
  let priceIndex = null;
  let priceListBlock = null;
  try {
    priceIndex = await (d.priceListData || priceListDefault).loadPriceIndex(salonId);
    priceListBlock = priceList.renderPriceListBlock(priceIndex);
  } catch (e) {
    logger.warn(`dialog ${dialogKey}: не собрать прайс-листы (${e.message}) — промпт без них`);
    priceIndex = null;
    priceListBlock = null;
  }

  // Живые варианты get_sequential_slots этого диалога → в волатильный хвост промпта.
  // Их мог создать только ПРЕДЫДУЩИЙ ход (в текущем результат инструмента модель
  // и так видит), поэтому одного peek перед циклом попыток достаточно. Сбой кэша
  // не имеет права ронять диалог — просто идём без блока (модель перезапросит слоты).
  let activeOffers = [];
  try {
    const live = seqOffers.peek(salonId, dialogKey, { nowMs });
    if (live) {
      activeOffers = seqOffers.renderOffers(live, { nowMs });
      // Часть вариантов не показана (прошедший старт, уже оформлен, потолок
      // строк) — модель по правилу блока просто перезапросит get_sequential_slots.
      const total = Object.keys(live).length;
      if (total > activeOffers.length) {
        logger.info(`dialog ${dialogKey}: активных вариантов ${activeOffers.length} из ${total} (остальные прошли, оформлены или срезаны потолком)`);
      }
    }
  } catch (e) {
    logger.warn(`dialog ${dialogKey}: не прочитать активные варианты стыковки (${e.message}) — промпт без них`);
    activeOffers = [];
  }

  // Память прошлых ходов: выжимка журнала инструментов → волатильный хвост
  // промпта. Сбой чтения/рендера не роняет ход — идём без блока (fail-open,
  // как activeOffers): модель просто переспросит инструментами.
  // AGENT_TOOL_MEMORY=false гасит РОВНО это — показ выжимки модели. Запись
  // журнала ниже по ходу идёт при любом значении флага: аварийное выключение
  // памяти не должно лишать нас форензики инцидента, ради которой журнал и заведён.
  let toolMemoryLines = [];
  if (cfg.AGENT_TOOL_MEMORY) {
    try {
      const rows = await toolEvents.loadRecent(salonId, dialogKey);
      const rendered = toolMemory.renderMemory(rows, { nowMs });
      toolMemoryLines = rendered.lines;
      if (rendered.dropped > 0) {
        logger.info(`dialog ${dialogKey}: журнал инструментов срезан капом (${rendered.dropped} событий не в промпте)`);
      }
    } catch (e) {
      logger.warn(`dialog ${dialogKey}: не прочитать журнал инструментов (${e.message}) — промпт без памяти`);
      toolMemoryLines = [];
    }
  }

  // Живые записи пациента из CRM → самый хвост промпта. Единственный источник,
  // который знает про отмену и удаление: и транскрипт, и журнал инструментов —
  // это ИСТОРИЯ (инцидент 2026-08-04: запись удалили в 23:35, в 23:40 Мила без
  // единого вызова инструмента заявила «вы уже записаны на завтра, 12:00»).
  // null = сверки не было (нет номера, сбой YClients) → блока нет, как раньше;
  // ПУСТОЙ массив = сверка прошла, записей нет — это утверждение, а не молчание.
  let liveBookings = null;
  if (ctx.phone) {
    try {
      const res = await (d.listBookings || listBookingsDefault)
        .run(salonId, {}, { clientPhone: ctx.phone, nowMs });
      // reason no_yclients / error — «не знаем», а не «записей нет»: молчим.
      if (res && Array.isArray(res.bookings) && !res.error && res.reason !== 'no_yclients') {
        const rendered = bookingsBlock.renderBookings(res.bookings, { nowMs });
        liveBookings = rendered.lines;
        if (rendered.dropped > 0) {
          logger.info(`dialog ${dialogKey}: записей пациента ${rendered.lines.length} из ${rendered.lines.length + rendered.dropped} (остальные срезаны потолком блока)`);
        }
      }
    } catch (e) {
      logger.warn(`dialog ${dialogKey}: не сверить записи пациента с CRM (${e.message}) — промпт без блока записей`);
      liveBookings = null;
    }
  }

  const promptOpts = {
    salonName: opts.salonName,
    workingHours: opts.workingHours,
    today: opts.today || todayMoscow(),
    now: opts.now || nowTimeMoscow(),
    // Вне окна присутствия администратора фраза эскалации не обещает
    // «с минуты на минуту» (аудит 2026-08-01: ночью это ложь).
    adminOffHours: adminHours.isAdminOffHours(opts.now || nowTimeMoscow(), cfg.AGENT_ADMIN_HOURS),
    stopTopics: opts.stopTopics,   // загружает диспетчер (agent_stop_topics)
    // status здесь всегда !== 'escalated' (иначе вышли бы выше). Непустой
    // escalated_reason при статусе 'bot' = диалог вернул боту администратор →
    // просим модель не эскалировать заново на уже разрешённом конфликте.
    resumedFromEscalation: !!dialog.escalated_reason,
    // Идентификация: знаем ли телефон (из канала) и имя (из карточки клиента).
    phoneKnown: !!ctx.phone,
    clientName: clientGivenName,
    catalogBlock,
    priceListBlock,
    activeOffers,
    toolMemory: toolMemoryLines,
    liveBookings,
  };
  // nowMs — чтобы инструменты слотов отрезали уже прошедшее время «сегодня».
  // clientPhone/clientName — детерминированный фолбэк для create_booking основного
  // пациента: модель не переспрашивает уже известный номер, а инструмент подставит его сам.
  const toolCtx = {
    dialogKey,
    clientPhone: ctx.phone,
    clientName,
    nowMs,
    // Канал нужен send_price_list: файлы Chatpush умеет только в whatsapp/tdlib/max.
    channel: ctx.channel || null,
    priceIndex,
  };

  for (let attempt = 0; attempt <= MAX_REGEN; attempt++) {
    const { messages, watermark, session } = await history.loadTranscript(
      salonId, dialogKey, { limit: 20, withTime: true });
    // Буфер вложений ЭТОЙ попытки. Пересоздаётся на каждой перегенерации:
    // черновик, выброшенный из-за нового входящего, обязан унести фото с собой,
    // иначе пациент получит картинку от ответа, которого он не увидит.
    toolCtx.attachments = [];
    if (!messages.length) return { replies: [], escalated: false, sideEffect: false };

    // Круг взаимных благодарностей: пациенту отвечать уже нечего. Проверка стоит
    // ДО провайдера — платный вызов ради «Всегда пожалуйста» не нужен, а модель
    // всё равно не смогла бы промолчать (ход без реплик диспетчер трактует как
    // отказ). Ватермарк двигаем как в штатном ходе, иначе то же сообщение
    // обрабатывалось бы заново на каждом следующем входящем.
    if (cfg.AGENT_CLOSING_SILENCE && closing.shouldStaySilent(messages)) {
      logger.info(`dialog ${dialogKey}: завершающая вежливость — молчим, последнее слово за пациентом`);
      await state.setWatermark(salonId, dialogKey, watermark);
      return { replies: [], escalated: false, sideEffect: false, silent: true };
    }

    // Буфер журнала tool-цикла этой ПОПЫТКИ. Создаётся после проверки пустого
    // транскрипта (там возвращаться нечему — не заводим буфер впустую).
    // Флашей ровно два смысловых: delivered=false на выброшенном перегенерацией
    // черновике и delivered=null перед штатным возвратом. Все прочие выходы
    // (падение провайдера, добивочного вызова, БД в хвосте, любой непредвиденный
    // throw) добирает страховочный flush(null) в finally обёртки runDialog —
    // ради него buf и кладётся в bag, причём КАЖДАЯ попытка перетирает ссылку
    // своим свежим буфером.
    const evBuffer = toolEvents.createBuffer(salonId, dialogKey);
    bag.buf = evBuffer;

    const convo = messages.slice();

    // Первое в истории обращение: приветствие и представление держались только
    // на промпт-правиле, и модель его обошла (инцидент 2026-08-06, 79165370505).
    // Признак из двух частей, и обе нужны:
    //  • в транскрипте нет НИ ОДНОЙ своей реплики — ловит свежую отправку, эхо
    //    которой ещё не легло в БД (она приходит из pendingReplies);
    //  • в БД нет ни одного исходящего за всю историю диалога — ловит всё, что
    //    не влезло в окно LIMIT 20, и срезанные ведущие assistant-реплики.
    // Порядок важен: своя реплика в транскрипте закрывает вопрос без запроса в
    // БД, то есть в живом диалоге лишнего похода нет.
    // Fail-open: сбой этой проверки — не повод терять ход. Без блока Мила
    // отвечает ровно как до фичи, с исключением пациент не получил бы ничего.
    // try/catch, а не .catch(): ловим и отказ БД, и синхронный TypeError на
    // неполной реализации history (у неё несколько инжекторов).
    let answeredBefore = true;
    if (!messages.some(m => m.role === 'assistant')) {
      try {
        answeredBefore = await history.hasEverAnswered(salonId, dialogKey);
      } catch (e) {
        logger.warn(`dialog ${dialogKey}: проверка первого обращения не удалась: ${e.message}`);
      }
    }
    const firstContact = !answeredBefore;

    // Промпт собирается ВНУТРИ цикла: граница переписки известна только после
    // загрузки транскрипта. Сборка — конкатенация строк, перегенераций не больше
    // MAX_REGEN, поэтому цена пренебрежимая.
    const system = buildSystemPrompt({ ...promptOpts, session, firstContact });

    // Допустимые времена для финальной реплики: всё, что реально всплывало в
    // этом ходе — история диалога (клиент сам называл время / мы уже предлагали),
    // текущее время из промпта и результаты инструментов (пополняется ниже).
    // Сверка — детерминированная страховка правила «время дословно из slots»
    // (инцидент 2026-07-28: выдуманное 14:00). Пока ТОЛЬКО лог — меряем шум.
    // Метки времени реплик — НЕ предложенные пациенту времена: без чистки
    // reply-guard считал бы разрешённым любое время отправки сообщения.
    const allowedTimes = new Set(replyGuard.extractTimes(stripAllStamps(JSON.stringify(messages))));
    for (const t of replyGuard.extractTimes(system)) allowedTimes.add(t);
    // При новой переписке приветствие — не повтор, а требование промпта:
    // reply-guard иначе пишет repeat_greeting ровно там, где Мила права.
    // Подавляем ровно в том случае, в каком промпт предписал поздороваться:
    // блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ» рендерится только при ИЗМЕРЕННОМ разрыве
    // (непустой gapText). Без gapText приветствие не предписано, и если модель
    // поздоровается посреди разговора — про это надо узнать из лога guard'а.
    const hasPriorAssistant = !(session && session.newSession && session.gapText)
      && messages.some(m => m.role === 'assistant');

    // Плотная запись (§8 спеки, checkOfferDeviation в reply-guard): промпт-правило
    // «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ» разрешает полный slots ДВУМЯ путями — пациент
    // назвал время ЦИФРАМИ (patientTimes) или попросил другое СЛОВАМИ, без цифр
    // («а есть пораньше?», OTHER_TIME_REQUEST_RE). Считаем ТОЛЬКО по роли user —
    // реплики Милы/администратора сюда не подмешиваются, и метку [дд.мм чч:мм]
    // чистим тем же stripAllStamps, что и allowedTimes выше; кусок текста общий
    // для обоих признаков — второй проход по транскрипту не нужен.
    const patientText = stripAllStamps(messages.filter(m => m.role === 'user').map(m => m.content).join('\n'));
    const patientTimes = new Set(replyGuard.extractTimes(patientText));
    const patientAskedOtherTime = replyGuard.OTHER_TIME_REQUEST_RE.test(patientText);
    // toolOfferTimes/offerSlotTimes пополняются в tool-цикле ниже (только на
    // результатах, где реально был offer_slots).
    const toolOfferTimes = new Set();
    const offerSlotTimes = new Set();
    // Свободный день: правило промпта требует не называть время, а спросить половину
    // дня. Только измерение (free_day_time), см. checkFreeDayTime в reply-guard.
    let sawFreeDay = false;

    const replies = [];
    let escalated = false;
    let sideEffect = false;
    let exhausted = false;
    let bookingSucceeded = false;   // create_booking вернул успех в этом ходе
    let bookingErrored = false;     // create_booking вернул ошибку в этом ходе
    let writeSucceeded = false;     // любой из WRITE_TOOLS отработал без ошибки в этом ходе
    let lastWrite = null;           // { tool, input } последнего успешного write — для подтверждения
    let degradedAfterWrite = false; // провайдер упал ПОСЛЕ успешной записи → детерминированное подтверждение
    let readBookings = false;       // list_client_bookings отработал → «вы записаны…» может быть честным ответом
    let recheckedAfterFail = false; // после провала create_booking модель перезапросила слоты (добросовестная переигровка)
    // Единственный легальный источник адреса/контактов клиники — статьи базы
    // знаний, прочитанные В ЭТОМ ходе (address-guard). Транскрипт и журнал
    // действий источниками не считаются: см. шапку address-guard.js.
    let kbSourceText = '';

    for (let i = 0; i < MAX_ITERS; i++) {
      let resp;
      try {
        resp = await provider.createMessage(
          { system, messages: convo.slice(), tools: registry.schemas },
          { client: opts.client });
      } catch (e) {
        // Провайдер упал (fallback внутри провайдера тоже не выжил). Если запись
        // в этом ходе УЖЕ сделана — не роняем ход в эскалацию: ниже отдадим
        // детерминированное подтверждение. Ничего не сделано → пробрасываем
        // (честная эскалация в диспетчере, как раньше).
        if (!writeSucceeded) throw e;
        logger.warn(`dialog ${dialogKey}: провайдер упал после успешной записи (${e.message}) — детерминированное подтверждение`);
        degradedAfterWrite = true;
        break;
      }

      convo.push(resp.assistantMsg);

      // Пациенту уходит ТОЛЬКО финальная реплика — ход без вызовов инструментов.
      // Промежуточный нарратив между tool-вызовами («Позвольте проверить… / Теперь
      // проверю слот… / Слот свободен, оформляю…») НЕ шлём: это внутренняя кухня,
      // раньше диспетчер спамил им клиента отдельными сообщениями. Модель уточнила
      // мастера/услугу/время → записала → сообщила одним сообщением.
      if (!resp.toolCalls.length) {
        if (resp.text) replies.push(resp.text);
        break;
      }

      const results = [];
      for (const tc of resp.toolCalls) {
        const handler = registry.handlers[tc.name];
        const startedAt = Date.now();
        let result;
        let threw = false;
        try {
          result = handler
            ? await handler(salonId, tc.input, toolCtx)
            : { error: `Неизвестный инструмент: ${tc.name}` };
        } catch (e) {
          threw = true;
          logger.error(`dialog ${dialogKey}: tool ${tc.name} ${Date.now() - startedAt}ms error ${String(e.message).slice(0, 120)}`);
          result = { error: e.message };
        }
        const isError = !!(result && result.error);
        // Журнал tool-цикла: сырые input/result в БД (форензика + память).
        evBuffer.push(tc.name, tc.input, result, isError);
        // Один лог на вызов инструмента (ok/error, длительность, решающие поля
        // без PII). Для исключения уже отработал logger.error выше — второй
        // раз не логируем, чтобы не задваивать одно и то же событие.
        if (!threw) {
          const outcome = summarizeToolResult(result);
          const args = summarizeToolInput(tc.input);
          logger.info(`dialog ${dialogKey}: tool ${tc.name}${args ? `(${args})` : ''} ${Date.now() - startedAt}ms ${isError ? 'error' : 'ok'}${outcome ? ' ' + outcome : ''}`);
        }
        if (!isError && SIDE_EFFECT_TOOLS.has(tc.name)) sideEffect = true;
        if (!isError && WRITE_TOOLS.has(tc.name)) { writeSucceeded = true; lastWrite = { tool: tc.name, input: tc.input }; }
        if (!isError && tc.name === 'list_client_bookings') readBookings = true;
        if (tc.name === 'escalate_to_operator' && result && result.escalated) escalated = true;
        if (tc.name === 'create_booking') { if (isError) bookingErrored = true; else bookingSucceeded = true; }
        if (tc.name === 'book_chain') {
          // Частичный успех (partial) = записи уже есть → право на «записала»
          // сохраняется (writeSucceeded) и ход нельзя выбрасывать перегенерацией
          // (sideEffect), но серия считается проваленной (bookingErrored) —
          // диспетчер решит про перевод. option_expired — ни успех, ни провал
          // записи: модель перезапросит слоты.
          if (result && (result.booked_all || result.partial)) sideEffect = true;
          if (result && result.booked_all) {
            bookingSucceeded = true; writeSucceeded = true;
            const first = (result.records || [])[0] || {};
            lastWrite = { tool: 'create_booking', input: { datetime: first.datetime, client_name: (tc.input || {}).client_name } };
          } else if (result && (result.partial || result.failed_at)) {
            bookingErrored = true;
            if (result.partial) {
              // Часть цепочки уже забронирована → writeSucceeded (ход не выбросить),
              // и lastWrite ставим из ПЕРВОЙ созданной записи, чтобы деградационное
              // подтверждение назвало реально забронированный слот, а не соврало
              // «всё оформила» про частичную бронь.
              writeSucceeded = true;
              const first = (result.records || [])[0] || {};
              lastWrite = { tool: 'create_booking', input: { datetime: first.datetime, client_name: (tc.input || {}).client_name } };
            }
          } else if (result && !result.option_expired) {
            bookingErrored = true;
          }
        }
        if (bookingErrored && SLOT_READ_TOOLS.has(tc.name)) recheckedAfterFail = true;
        results.push({ id: tc.id, name: tc.name, result, isError });
        const resultJson = JSON.stringify(result);
        for (const t of replyGuard.extractTimes(resultJson)) allowedTimes.add(t);
        // Плотная запись (§8 спеки): ограничиваем ИМЕННО результатами, где реально
        // есть offer_slots (get_available_slots и ретрай create_booking при отказе
        // по времени) — не любым tool-вызовом. Иначе время из ответа
        // list_client_bookings («вы записаны на 14:00») ловилось бы как нарушение,
        // хотя это честное подтверждение существующей записи, а не предложенный слот.
        if (resultJson && resultJson.includes('"offer_slots"')) {
          for (const t of replyGuard.extractTimes(resultJson)) toolOfferTimes.add(t);
          collectOfferSlotTimes(result, offerSlotTimes);
        }
        // free_day приходит и на верхнем уровне, и внутри staff_options[]/
        // alternative_staff[] — по строке результата это одна проверка на все ветки.
        if (resultJson && resultJson.includes('"free_day":true')) sawFreeDay = true;
        if (!isError && tc.name === 'search_knowledge_base') kbSourceText += JSON.stringify(result);
      }
      for (const m of provider.toolResultMessages(results)) convo.push(m);
      if (escalated) {
        // Текст, написанный В ТОМ ЖЕ ходе, что и escalate_to_operator (прощание /
        // честный отчёт о частичной записи цепочки), иначе теряется: ветка выше
        // пушит text в replies ТОЛЬКО когда toolCalls пуст, а цикл прерывается
        // сразу после эскалации — текстового хода без инструментов больше не будет.
        // Это последнее, что услышит клиент перед переводом на администратора.
        if (resp.text && !replies.includes(resp.text)) replies.push(resp.text);
        break;
      }
      if (i === MAX_ITERS - 1) exhausted = true;
    }

    // Лимит выбило, а связного ответа так и не появилось (модель всё это время
    // молча дёргала инструменты). Данные уже собраны — грех их выбрасывать:
    // добиваем одним вызовом БЕЗ инструментов, чтобы модель была вынуждена
    // ответить прозой. Без этого ход завершался нулём реплик и клиент — тишиной.
    if (exhausted && replies.length === 0 && !degradedAfterWrite) {
      logger.warn(`dialog ${dialogKey}: исчерпан лимит tool-итераций (${MAX_ITERS}) без единой реплики — добивочный вызов без инструментов`);
      try {
        const final = await provider.createMessage(
          { system, messages: convo.slice(), tools: [] },
          { client: opts.client });
        if (final.text) replies.push(final.text);
        else logger.warn(`dialog ${dialogKey}: добивочный вызов тоже без текста — ответ клиенту берёт на себя диспетчер`);
      } catch (e) {
        if (!writeSucceeded) throw e;
        logger.warn(`dialog ${dialogKey}: добивочный вызов упал после успешной записи (${e.message}) — детерминированное подтверждение`);
        degradedAfterWrite = true;
      }
    }

    // Провайдер умер уже ПОСЛЕ успешной записи — реплики нет, но бронь есть.
    // Не эскалируем в пустоту: отдаём правдивое подтверждение из данных брони.
    if (degradedAfterWrite && replies.length === 0) {
      replies.push(buildWriteConfirmation(lastWrite));
    }

    // ── Ложное утверждение о записи при ПУСТОЙ сверке: корректирующий довызов ──
    //
    // Сверенное состояние записей ЭТОГО хода: true — записи есть, false — записей
    // нет, null — сверки не было (нет номера / сбой YClients → блока в промпте
    // тоже нет). Полярность важна: утверждение о записи честно ровно тогда, когда
    // СОВПАДАЕТ со сверкой. Иначе гейт «сверка была → верим» пропустил бы
    // «я отменила вашу запись» при живой записи — ровно ту ложь, ради которой
    // guard и заводился.
    const bookingsExist = Array.isArray(liveBookings) ? liveBookings.length > 0 : null;
    // readBookings (модель сама звала list_client_bookings) остаётся источником
    // истины ТОЛЬКО для «запись есть» — так это работало с 26.07. Для «записи
    // нет» его мало: «отменила» после чтения списка ничем не подтверждается, а
    // цена ошибки здесь — пациент считает визит отменённым, хотя он в силе.
    const claimProof = {
      existsHonest: readBookings || bookingsExist === true,
      cancelledHonest: bookingsExist === false,
    };
    // ЗАЧЕМ довызов вместо перевода на человека. Блок «АКТУАЛЬНЫЕ ЗАПИСИ
    // ПАЦИЕНТА» прямо говорит модели: запись пропала — ШТАТНАЯ ситуация,
    // предложи подобрать время заново, а НЕ переводи на администратора. Guard
    // делал ровно обратное (прод 2026-08-06, 79200255591: запись удалили в
    // YClients через 3 минуты после создания, на следующий вопрос пациента
    // реплику погасили и увели диалог к администратору). Правда тут известна
    // ДЕТЕРМИНИРОВАННО — сверка прошла и записей нет, — значит ход чинится
    // одним довызовом. Только при ПУСТОЙ сверке: при живой записи («перенесла»)
    // и при отсутствии сверки сказать модели нечего, там перевод как раньше.
    // Side-effect'а на таком ходу нет по определению (условие включает
    // !writeSucceeded), поэтому довызов безопасен; инструменты ему не даём —
    // исправление не должно ничего записывать. Довызов ОДИН: если исправленный
    // текст тоже лжёт, финальная проверка ниже вернёт falseSuccess и диспетчер
    // переведёт на человека, как раньше.
    //
    // МЕСТО — ДО reply-guard, а не после: исправленный текст пишется заново и
    // обязан пройти тот же линт (утечка id/внутренней кухни, сверка времён),
    // иначе он ехал бы к пациенту вообще без проверок. Обратный порядок, как у
    // address-guard, тут не нужен: reply-guard переписывает текст «тем же
    // смыслом», то есть заявление о записи назад не вернёт, а если вернёт —
    // финальная проверка внизу это поймает.
    if (!escalated && !writeSucceeded && !degradedAfterWrite
        && bookingsExist === false && replies.length) {
      const kind = detectFalseClaim(replies.join('\n'), claimProof);
      if (kind) {
        logger.warn(`dialog ${dialogKey}: реплика утверждает состояние записи (${kind}) вопреки сверке с CRM (записей нет) — корректирующий довызов`);
        try {
          const fix = await provider.createMessage({
            system,
            messages: convo.concat([{ role: 'user', content: FALSE_CLAIM_CORRECTION }]),
            tools: [],
          }, { client: opts.client });
          if (fix.text) { replies.length = 0; replies.push(fix.text); }
          else logger.warn(`dialog ${dialogKey}: корректирующий довызов вернул пустой текст — отдаю исходную реплику`);
        } catch (e) {
          logger.warn(`dialog ${dialogKey}: корректирующий довызов не удался (${e.message}) — отдаю исходную реплику`);
        }
      }
    }

    // ── Линт финальной реплики (reply-guard) ──
    if (replies.length && !degradedAfterWrite) {
      const joined = replies.join('\n');
      const violations = [
        ...replyGuard.lintReply(joined, { hasPriorAssistant, firstContact }),
        ...replyGuard.checkOfferedTimes(joined, allowedTimes),
        // Плотная запись (§8 спеки): только лог, переписывания нет (offer_bypass
        // не входит в HARD_TYPES) — см. шапку checkOfferDeviation в reply-guard.js.
        ...replyGuard.checkOfferDeviation(joined,
          { toolTimes: toolOfferTimes, offerTimes: offerSlotTimes, patientTimes, patientAskedOtherTime }),
        // Свободный день (правка 07.08): времени в ответе быть не должно вовсе —
        // только вопрос о половине дня. Тоже ЛИШЬ лог, без переписывания.
        ...replyGuard.checkFreeDayTime(joined, { freeDay: sawFreeDay, patientTimes }),
      ];
      if (violations.length) {
        logger.warn(`dialog ${dialogKey}: reply-guard: ${JSON.stringify(violations)}`);
      }
      const hard = replyGuard.hardViolations(violations);
      if (hard.length) {
        // ОДИН корректирующий довызов без инструментов: убрать внутреннюю кухню,
        // сохранив смысл. Второй раз не переписываем — доставляем как есть (лог уже был).
        try {
          const fix = await provider.createMessage({
            system,
            messages: convo.concat([{
              role: 'user',
              content: 'СЛУЖЕБНАЯ ПРОВЕРКА (пациент этого не видит): твой последний ответ ' +
                `содержит внутренние термины или идентификаторы: ${hard.map(v => v.value).join(', ')}. ` +
                'Перепиши его для пациента тем же смыслом, но без этих слов и чисел. ' +
                'В ответе — ТОЛЬКО переписанный текст.',
            }]),
            tools: [],
          }, { client: opts.client });
          if (fix.text) { replies.length = 0; replies.push(fix.text); }
          else logger.warn(`dialog ${dialogKey}: корректирующий довызов вернул пустой текст — отдаю исходную реплику`);
        } catch (e) {
          logger.warn(`dialog ${dialogKey}: корректирующий довызов не удался (${e.message}) — отдаю исходную реплику`);
        }
      }
    }

    // Метка времени вырезается из реплик ДЕТЕРМИНИРОВАННО, а не только
    // запрещается промптом: в транскрипте с неё начинается КАЖДАЯ ассистентская
    // реплика, и для модели это сильнейший образец для подражания — она ставит
    // метку и в своём ответе. На исходящей стороне её не ловит ничто (id_leak
    // требует шести цифр подряд, unknown_time — лог-only и при совпадении минуты
    // с текущей молчит), так что пациенту уходило бы «[05.08 09:12] Здравствуйте!».
    // Точка ОДНА и последняя: здесь реплики уже финальны — позади и добивочный
    // вызов, и детерминированное подтверждение записи, и переписывание reply-guard,
    // а впереди только чтение (falseSuccess / REPLY_HAS_TIME) и диспетчер.
    // stripStamp срезает метку лишь в начале строк — обычная реплика проходит байт-в-байт.
    // Порядок с reply-guard намеренный: checkOfferedTimes выше линтует реплику
    // ЕЩЁ С меткой, и напечатанное моделью «[05.08 09:12]» добавит в лог
    // unknown_time. Guard там в режиме лога, а знать, что модель повторяет
    // служебную метку, полезно — тишина здесь была бы потерей сигнала.
    for (let i = 0; i < replies.length; i++) replies[i] = stripStamp(replies[i]);

    // Адрес клиники — только из статьи базы знаний, прочитанной В ЭТОМ ходе.
    // Инцидент 2026-08-06 (79037504378): после успешной записи Мила дописала
    // «Наш адрес: 2-й Троицкий переулок, 6Ас4» — адрес выдуман, а
    // search_knowledge_base за весь ход не вызывался ни разу (журнал
    // agent_tool_events: только get_available_slots и create_booking).
    // Место — ПОСЛЕ переписывания reply-guard (иначе корректирующий довызов
    // вернул бы адрес обратно) и ДО дописки приветствия (ей чистить нечего).
    {
      const scrubbed = addressGuard.scrubAddresses(replies, { sourceText: kbSourceText });
      if (scrubbed.removed.length) {
        logger.warn(`dialog ${dialogKey}: адрес без источника в базе знаний — вырезано: ${JSON.stringify(scrubbed.removed)}`);
        replies.length = 0;
        replies.push(...scrubbed.replies);
        // Реплика состояла ТОЛЬКО из адреса, а запись при этом оформлена:
        // молчание диспетчер трактует как отказ и уводит на администратора —
        // пациент остался бы без подтверждения уже созданной брони. Отдаём то
        // же детерминированное подтверждение, что и при падении провайдера.
        if (!replies.length && writeSucceeded) replies.push(buildWriteConfirmation(lastWrite));
      }
    }

    // Приветствие в первом сообщении переписки — детерминированно, а не только
    // промптом. Инцидент 2026-08-06 (79165370505): блок «ПЕРВОЕ ОБРАЩЕНИЕ»
    // модель отрабатывает не всегда — на живом пробнике ветка известного
    // пациента с отказом по времени дала приветствие 1 раз из 3 (правило
    // проигрывает соседним «сразу выдавай суть»). Тот же приём, что с блоком
    // актуальных записей: факт бьёт правило.
    // Место — ПОСЛЕ stripStamp и переписывания reply-guard: реплики уже
    // финальны, и наш текст не должен попасть под чужие чистки. Ветка
    // degradedAfterWrite сюда тоже заходит: пациенту, получившему одно лишь
    // детерминированное подтверждение записи, приветствие нужно не меньше.
    if (firstContact && replies.length && !greeting.hasGreeting(replies.join('\n'))) {
      logger.info(`dialog ${dialogKey}: первое обращение без приветствия — дописываю детерминированно`);
      const fixed = greeting.ensureGreeting(replies, {
        givenName: clientGivenName, salonName: opts.salonName,
      });
      replies.length = 0;
      replies.push(...fixed);
    }

    // Пришло ли новое входящее, пока мы думали?
    const stale = await history.hasIncomingAfter(salonId, dialogKey, watermark);
    if (stale && !sideEffect && attempt < MAX_REGEN) {
      logger.info(`dialog ${dialogKey}: новое сообщение во время прогона — выбрасываю черновик, перегенерация (${attempt + 1})`);
      await evBuffer.flush(false);   // события выброшенной попытки пациент не видел
      continue;
    }

    await state.setWatermark(salonId, dialogKey, watermark);
    // falseSuccess: реплика утверждает, что запись перенесена/отменена/создана, но
    // ни один пишущий инструмент в этом ходе не отработал (модель соврала). Диспетчер
    // по этому сигналу НЕ отправляет ложь, а переводит на человека. Пилот 2026-07-22.
    const allReplies = replies.join('\n');
    // Считается на ФИНАЛЬНОМ тексте: если выше был корректирующий довызов, здесь
    // проверяется уже исправленная реплика (не исправился — перевод как раньше).
    const falseSuccessKind = (!escalated && !writeSucceeded)
      ? detectFalseClaim(allReplies, claimProof) : null;
    const falseSuccess = !!falseSuccessKind;
    // bookingFailed: попытка записи была и НЕ увенчалась успехом. Диспетчер по этому
    // сигналу принудительно переведёт на человека, чтобы клиент не завис на «секундочку».
    const bookingFailed = bookingErrored && !bookingSucceeded;
    // bookingFailRecoverable: провал записи, но модель добросовестно ПЕРЕИГРАЛА —
    // не соврала об успехе, дала связную реплику и либо перепроверила слоты, либо
    // предложила конкретное новое время. Такой ход диспетчер доставляет пациенту
    // БЕЗ перевода на человека (переигровка ограничена одной попыткой на серию —
    // счётчик провалов в диспетчере). Инцидент 2026-07-28: восстановимый провал
    // «время занято» уводил на администратора, хотя достаточно предложить другой слот.
    const bookingFailRecoverable = bookingFailed && !escalated && !falseSuccess
      && replies.some((t) => t && t.trim())
      && (recheckedAfterFail || REPLY_HAS_TIME.test(allReplies));
    // Вердикт delivered поставит диспетчер после отправки. AWAIT ОБЯЗАТЕЛЕН, и
    // снимать его «ради задержки» нельзя: markDelivered — это UPDATE … WHERE
    // turn_id=$1 AND delivered IS NULL, и если вердикт диспетчера обгонит этот
    // INSERT, он не найдёт ни одной строки — все read-события хода навсегда
    // останутся невидимыми для памяти.
    await evBuffer.flush(null);
    return { replies, escalated, sideEffect, exhausted, falseSuccess, falseSuccessKind,
      bookingFailed, bookingFailRecoverable, degradedAfterWrite, turnId: evBuffer.turnId,
      attachments: toolCtx.attachments };
  }

  return { replies: [], escalated: false, sideEffect: false };
}

module.exports = { runDialog, detectFalseClaim, todayMoscow, MAX_ITERS, MAX_REGEN };
