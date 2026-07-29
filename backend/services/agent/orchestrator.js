'use strict';

const providers = require('./providers');
const registryDefault = require('./tools');
const historyDefault = require('./history');
const stateDefault = require('./dialog-state');
const identityDefault = require('./identity');
const config = require('../../config');
const catalogBlockDefault = require('./catalog-block');
const replyGuard = require('./reply-guard');
const { buildSystemPrompt } = require('./system-prompt');
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
  'create_booking', 'cancel_booking', 'reschedule_booking', 'modify_booking_services',
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
async function runDialog(salonId, dialogKey, opts = {}) {
  const d = opts.deps || {};
  const provider = d.provider || providers.getProvider();
  const history = d.history || historyDefault;
  const state = d.state || stateDefault;
  const identity = d.identity || identityDefault;
  const ctx = opts.ctx || {};

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
  const clientName = (client && client.name && String(client.name).trim()) || null;

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

  const system = buildSystemPrompt({
    salonName: opts.salonName,
    workingHours: opts.workingHours,
    today: opts.today || todayMoscow(),
    now: opts.now || nowTimeMoscow(),
    stopTopics: opts.stopTopics,   // загружает диспетчер (agent_stop_topics)
    // status здесь всегда !== 'escalated' (иначе вышли бы выше). Непустой
    // escalated_reason при статусе 'bot' = диалог вернул боту администратор →
    // просим модель не эскалировать заново на уже разрешённом конфликте.
    resumedFromEscalation: !!dialog.escalated_reason,
    // Идентификация: знаем ли телефон (из канала) и имя (из карточки клиента).
    phoneKnown: !!ctx.phone,
    clientName,
    catalogBlock,
  });
  // nowMs — чтобы инструменты слотов отрезали уже прошедшее время «сегодня».
  // clientPhone/clientName — детерминированный фолбэк для create_booking основного
  // пациента: модель не переспрашивает уже известный номер, а инструмент подставит его сам.
  const toolCtx = {
    dialogKey,
    clientPhone: ctx.phone,
    clientName,
    nowMs: opts.nowMs || Date.now(),
  };

  for (let attempt = 0; attempt <= MAX_REGEN; attempt++) {
    const { messages, watermark } = await history.loadTranscript(salonId, dialogKey, { limit: 20 });
    if (!messages.length) return { replies: [], escalated: false, sideEffect: false };

    const convo = messages.slice();

    // Допустимые времена для финальной реплики: всё, что реально всплывало в
    // этом ходе — история диалога (клиент сам называл время / мы уже предлагали),
    // текущее время из промпта и результаты инструментов (пополняется ниже).
    // Сверка — детерминированная страховка правила «время дословно из slots»
    // (инцидент 2026-07-28: выдуманное 14:00). Пока ТОЛЬКО лог — меряем шум.
    const allowedTimes = new Set(replyGuard.extractTimes(JSON.stringify(messages)));
    for (const t of replyGuard.extractTimes(system)) allowedTimes.add(t);
    const hasPriorAssistant = messages.some(m => m.role === 'assistant');

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
        let result;
        try {
          result = handler
            ? await handler(salonId, tc.input, toolCtx)
            : { error: `Неизвестный инструмент: ${tc.name}` };
        } catch (e) {
          logger.error(`tool ${tc.name} failed: ${e.message}`);
          result = { error: e.message };
        }
        const isError = !!(result && result.error);
        if (!isError && SIDE_EFFECT_TOOLS.has(tc.name)) sideEffect = true;
        if (!isError && WRITE_TOOLS.has(tc.name)) { writeSucceeded = true; lastWrite = { tool: tc.name, input: tc.input }; }
        if (!isError && tc.name === 'list_client_bookings') readBookings = true;
        if (tc.name === 'escalate_to_operator' && result && result.escalated) escalated = true;
        if (tc.name === 'create_booking') { if (isError) bookingErrored = true; else bookingSucceeded = true; }
        if (bookingErrored && SLOT_READ_TOOLS.has(tc.name)) recheckedAfterFail = true;
        results.push({ id: tc.id, name: tc.name, result, isError });
        for (const t of replyGuard.extractTimes(JSON.stringify(result))) allowedTimes.add(t);
      }
      for (const m of provider.toolResultMessages(results)) convo.push(m);
      if (escalated) break;
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
        } catch (e) {
          logger.warn(`dialog ${dialogKey}: корректирующий довызов не удался (${e.message}) — отдаю исходную реплику`);
        }
      }
    }

    // Пришло ли новое входящее, пока мы думали?
    const stale = await history.hasIncomingAfter(salonId, dialogKey, watermark);
    if (stale && !sideEffect && attempt < MAX_REGEN) {
      logger.info(`dialog ${dialogKey}: новое сообщение во время прогона — выбрасываю черновик, перегенерация (${attempt + 1})`);
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
    return { replies, escalated, sideEffect, exhausted, falseSuccess,
      bookingFailed, bookingFailRecoverable, degradedAfterWrite };
  }

  return { replies: [], escalated: false, sideEffect: false };
}

module.exports = { runDialog, todayMoscow, MAX_ITERS, MAX_REGEN };
