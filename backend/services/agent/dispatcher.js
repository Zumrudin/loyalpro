'use strict';

const config = require('../../config');
const agentSettings = require('../agent-settings');
const chatpush = require('../chatpush');
const orchestratorDefault = require('./orchestrator');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentDispatcher');

// Один PM2-процесс → in-memory состояние (спека [2]: дебаунс на один процесс).
const timers = new Map();   // key → { timer, meta }  (дебаунс серии)
const running = new Set();   // key диалогов в обработке (сериализация в процессе)
const rerun = new Set();     // пришло входящее, пока диалог обрабатывался

function keyOf(salonId, dialogKey) { return `${salonId}:${dialogKey}`; }

// Вызывается из вебхука на каждое ВХОДЯЩЕЕ. Копит серию, запускает после тишины.
// opts (для тестов): { debounceMs, settings, orchestrator, send }.
function enqueue(salonId, dialogKey, meta, opts = {}) {
  const k = keyOf(salonId, dialogKey);
  const debounceMs = opts.debounceMs || config.AGENT_DEBOUNCE_MS;
  if (running.has(k)) rerun.add(k);   // прогон уже идёт — перезапустим после него

  const existing = timers.get(k);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    timers.delete(k);
    void process(salonId, dialogKey, meta, opts);
  }, debounceMs);
  timers.set(k, { timer, meta });
}

async function process(salonId, dialogKey, meta, opts = {}) {
  const k = keyOf(salonId, dialogKey);
  const settings = opts.settings || agentSettings;
  const orchestrator = opts.orchestrator || orchestratorDefault;
  const send = opts.send || defaultSend;

  const gate = await settings.isAllowed(salonId, meta.phone);
  if (!gate.allow) { logger.info(`gate skip ${dialogKey} (${gate.reason})`); return; }

  if (running.has(k)) { rerun.add(k); return; }
  running.add(k);
  try {
    const res = await orchestrator.runDialog(salonId, dialogKey, { ctx: { phone: meta.phone } });
    for (const text of (res.replies || [])) {
      if (text && text.trim()) await send(meta, text);
    }
  } catch (e) {
    logger.error(`dialog ${dialogKey} failed: ${e.message}`);
  } finally {
    running.delete(k);
  }
  if (rerun.delete(k)) {
    logger.info(`dialog ${dialogKey}: отложенный прогон (сообщение пришло во время обработки)`);
    return process(salonId, dialogKey, meta, opts);
  }
}

// Отправка одной реплики обратно клиенту через chatpush.
async function defaultSend(meta, text) {
  const token = config.CHATPUSH.instanceToken;
  if (!token) { logger.error('CHATPUSH_INSTANCE_TOKEN not set — cannot reply'); return; }
  return chatpush.sendMessage(token, {
    text,
    phone: meta.phone,
    dispatchRouting: [chatpush.replyRoutingFor(meta.channel)],
    replyToMessageId: meta.messageId,
  });
}

// Сброс in-memory состояния — только для тестов.
function _reset() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear(); running.clear(); rerun.clear();
}

module.exports = { enqueue, process, defaultSend, _reset };
