'use strict';

const claudeDefault = require('./claude');
const registryDefault = require('./tools');
const historyDefault = require('./history');
const stateDefault = require('./dialog-state');
const { buildSystemPrompt } = require('./system-prompt');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentOrchestrator');

const MAX_ITERS = 6;   // защитный лимит tool-use итераций на один ход
const MAX_REGEN = 2;   // сколько раз перегенерировать при новом входящем во время прогона

// Пишущие инструменты: их результат нельзя «выбросить» перегенерацией.
const SIDE_EFFECT_TOOLS = new Set(['create_booking', 'escalate_to_operator']);

// YYYY-MM-DD по Москве (для системного промпта «сегодня …»).
function todayMoscow() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}

// Прогнать один ход диалога. Возвращает { replies, escalated, sideEffect }.
async function runDialog(salonId, dialogKey, opts = {}) {
  const d = opts.deps || {};
  const claude = d.claude || claudeDefault;
  const registry = d.registry || registryDefault;
  const history = d.history || historyDefault;
  const state = d.state || stateDefault;
  const ctx = opts.ctx || {};

  const dialog = await state.getOrCreate(salonId, dialogKey);
  if (dialog.status === 'escalated') {
    return { replies: [], escalated: true, sideEffect: false };
  }

  const system = buildSystemPrompt({
    salonName: opts.salonName,
    workingHours: opts.workingHours,
    today: opts.today || todayMoscow(),
  });
  const toolCtx = { dialogKey, clientPhone: ctx.phone };

  for (let attempt = 0; attempt <= MAX_REGEN; attempt++) {
    const { messages, watermark } = await history.loadTranscript(salonId, dialogKey, { limit: 20 });
    if (!messages.length) return { replies: [], escalated: false, sideEffect: false };

    const convo = messages.slice();
    const replies = [];
    let escalated = false;
    let sideEffect = false;

    for (let i = 0; i < MAX_ITERS; i++) {
      const message = await claude.createMessage(
        { system, messages: convo.slice(), tools: registry.schemas },
        { client: opts.client });
      const { text, toolUses, stopReason } = claude.splitContent(message);

      convo.push({ role: 'assistant', content: message.content });
      if (text) replies.push(text);

      if (stopReason !== 'tool_use' || !toolUses.length) break;

      const resultBlocks = [];
      for (const tu of toolUses) {
        const handler = registry.handlers[tu.name];
        let result;
        try {
          result = handler
            ? await handler(salonId, tu.input, toolCtx)
            : { error: `Неизвестный инструмент: ${tu.name}` };
        } catch (e) {
          logger.error(`tool ${tu.name} failed: ${e.message}`);
          result = { error: e.message };
        }
        const isError = !!(result && result.error);
        if (!isError && SIDE_EFFECT_TOOLS.has(tu.name)) sideEffect = true;
        if (tu.name === 'escalate_to_operator' && result && result.escalated) escalated = true;
        resultBlocks.push(claude.toolResultBlock(tu.id, result, isError));
      }
      convo.push({ role: 'user', content: resultBlocks });
      if (escalated) break;
    }

    // Пришло ли новое входящее, пока мы думали?
    const stale = await history.hasIncomingAfter(salonId, dialogKey, watermark);
    if (stale && !sideEffect && attempt < MAX_REGEN) {
      logger.info(`dialog ${dialogKey}: новое сообщение во время прогона — выбрасываю черновик, перегенерация (${attempt + 1})`);
      continue;   // выбрасываем текстовый черновик, крутим заново с полным контекстом
    }

    await state.setWatermark(salonId, dialogKey, watermark);
    return { replies, escalated, sideEffect };
  }

  return { replies: [], escalated: false, sideEffect: false };
}

module.exports = { runDialog, todayMoscow, MAX_ITERS, MAX_REGEN };
