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
const adminHours = require('./admin-hours');
const toolEventsDefault = require('./tool-events');
const toolMemoryDefault = require('./tool-memory');
const listBookingsDefault = require('./tools/list-client-bookings');
const bookingsBlock = require('./bookings-block');
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

// Реплика содержит конкретное время (HH:MM / HH.MM) — модель предлагает слот.
// Второй (наряду с перепроверкой слотов) признак переигровки после провала записи:
// «это время заняли, могу 15:00 или 16:00» — против пустого «секундочку».
const REPLY_HAS_TIME = /\b([01]?\d|2[0-3])[:.][0-5]\d\b/;

// Утверждение о ВЫПОЛНЕННОМ действии над записью (не намерение). Пилот
// claude-haiku 2026-07-22: модель написала «Готово, перенесла на 14:00», НЕ
// вызвав reschedule_booking, — клиенту ушла ложь. Ловим завершённые формы
// (перенесл-а/-и, перенесён, отменил-а, оформлен, «вы записаны», «запись
// перенесена/…»); инфинитивы намерения («перенести», «отменить») НЕ триггерят.
const COMPLETION_CLAIM =
  /(перенесл[аио]|перенёс|перенесен[оа]|отменил[аи]?|отменен[оа]|оформлен[оа]|подтверждена|записал[аи]?\s+вас|запись\s+(создан|перенесен|отменен|оформлен|подтвержден)|добавил[аи]|добавлен[аоы]|убрал[аи]|убран[аоы])/i;

// «Вы записаны…» — двусмысленно: это и ложный успех НОВОЙ записи, и честный ответ
// про СУЩЕСТВУЮЩУЮ (вопрос «когда я записан?»). Гейтим только если модель НЕ читала
// записи клиента (list_client_bookings) в этом ходе. Polza-пилот gemini-2.5-pro
// 2026-07-26: честный ответ «Вы записаны на 27 июля в 11:00» уходил в эскалацию.
const BOOKED_STATE_CLAIM = /вы\s+записаны/i;

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
  };

  for (let attempt = 0; attempt <= MAX_REGEN; attempt++) {
    const { messages, watermark, session } = await history.loadTranscript(
      salonId, dialogKey, { limit: 20, withTime: true });
    if (!messages.length) return { replies: [], escalated: false, sideEffect: false };

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

    // Промпт собирается ВНУТРИ цикла: граница переписки известна только после
    // загрузки транскрипта. Сборка — конкатенация строк, перегенераций не больше
    // MAX_REGEN, поэтому цена пренебрежимая.
    const system = buildSystemPrompt({ ...promptOpts, session });

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
    const hasPriorAssistant = !(session && session.newSession)
      && messages.some(m => m.role === 'assistant');

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
        for (const t of replyGuard.extractTimes(JSON.stringify(result))) allowedTimes.add(t);
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

    // ── Линт финальной реплики (reply-guard) ──
    if (replies.length && !degradedAfterWrite) {
      const joined = replies.join('\n');
      const violations = [
        ...replyGuard.lintReply(joined, { hasPriorAssistant }),
        ...replyGuard.checkOfferedTimes(joined, allowedTimes),
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
    const falseSuccess = !escalated && !writeSucceeded
      && (COMPLETION_CLAIM.test(allReplies)
        || (!readBookings && BOOKED_STATE_CLAIM.test(allReplies)));
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
    return { replies, escalated, sideEffect, exhausted, falseSuccess,
      bookingFailed, bookingFailRecoverable, degradedAfterWrite, turnId: evBuffer.turnId };
  }

  return { replies: [], escalated: false, sideEffect: false };
}

module.exports = { runDialog, todayMoscow, MAX_ITERS, MAX_REGEN };
