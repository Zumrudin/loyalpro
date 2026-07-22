'use strict';

const providers = require('./providers');
const registryDefault = require('./tools');
const historyDefault = require('./history');
const stateDefault = require('./dialog-state');
const identityDefault = require('./identity');
const { buildSystemPrompt } = require('./system-prompt');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentOrchestrator');

// Защитный лимит tool-use итераций на один ход. Не жадничать: Gemini Flash Lite
// отдаёт tool_calls с ПУСТЫМ content, поэтому упёршийся в лимит ход не оставляет
// ни единой реплики. Мультизапрос («мне пилинг, а дочке фототерапия») легко берёт
// 7–8 вызовов: list_services → list_staff → dates → slots × N.
const MAX_ITERS = 12;
const MAX_REGEN = 2;   // сколько раз перегенерировать при новом входящем во время прогона

// Пишущие инструменты: их результат нельзя «выбросить» перегенерацией.
const SIDE_EFFECT_TOOLS = new Set([
  'create_booking', 'cancel_booking', 'reschedule_booking', 'escalate_to_operator',
]);

// YYYY-MM-DD по Москве (для системного промпта «сегодня …»).
function todayMoscow() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}

// HH:MM по Москве (для промпта — чтобы модель не предлагала прошедшее время).
function nowTimeMoscow() {
  return new Intl.DateTimeFormat('ru-RU',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

// Прогнать один ход диалога. Возвращает { replies, escalated, sideEffect }.
async function runDialog(salonId, dialogKey, opts = {}) {
  const d = opts.deps || {};
  const provider = d.provider || providers.getProvider();
  const registry = d.registry || registryDefault;
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
    const replies = [];
    let escalated = false;
    let sideEffect = false;
    let exhausted = false;
    let bookingSucceeded = false;   // create_booking вернул успех в этом ходе
    let bookingErrored = false;     // create_booking вернул ошибку в этом ходе

    for (let i = 0; i < MAX_ITERS; i++) {
      const resp = await provider.createMessage(
        { system, messages: convo.slice(), tools: registry.schemas },
        { client: opts.client });

      convo.push(resp.assistantMsg);
      if (resp.text) replies.push(resp.text);

      if (!resp.toolCalls.length) break;

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
        if (tc.name === 'escalate_to_operator' && result && result.escalated) escalated = true;
        if (tc.name === 'create_booking') { if (isError) bookingErrored = true; else bookingSucceeded = true; }
        results.push({ id: tc.id, name: tc.name, result, isError });
      }
      for (const m of provider.toolResultMessages(results)) convo.push(m);
      if (escalated) break;
      if (i === MAX_ITERS - 1) exhausted = true;
    }

    // Лимит выбило, а связного ответа так и не появилось (модель всё это время
    // молча дёргала инструменты). Данные уже собраны — грех их выбрасывать:
    // добиваем одним вызовом БЕЗ инструментов, чтобы модель была вынуждена
    // ответить прозой. Без этого ход завершался нулём реплик и клиент — тишиной.
    if (exhausted && replies.length === 0) {
      logger.warn(`dialog ${dialogKey}: исчерпан лимит tool-итераций (${MAX_ITERS}) без единой реплики — добивочный вызов без инструментов`);
      const final = await provider.createMessage(
        { system, messages: convo.slice(), tools: [] },
        { client: opts.client });
      if (final.text) replies.push(final.text);
      else logger.warn(`dialog ${dialogKey}: добивочный вызов тоже без текста — ответ клиенту берёт на себя диспетчер`);
    }

    // Пришло ли новое входящее, пока мы думали?
    const stale = await history.hasIncomingAfter(salonId, dialogKey, watermark);
    if (stale && !sideEffect && attempt < MAX_REGEN) {
      logger.info(`dialog ${dialogKey}: новое сообщение во время прогона — выбрасываю черновик, перегенерация (${attempt + 1})`);
      continue;
    }

    await state.setWatermark(salonId, dialogKey, watermark);
    // bookingFailed: попытка записи была и НЕ увенчалась успехом. Диспетчер по этому
    // сигналу принудительно переведёт на человека, чтобы клиент не завис на «секундочку».
    return { replies, escalated, sideEffect, exhausted, bookingFailed: bookingErrored && !bookingSucceeded };
  }

  return { replies: [], escalated: false, sideEffect: false };
}

module.exports = { runDialog, todayMoscow, MAX_ITERS, MAX_REGEN };
