'use strict';

const config = require('../../config');
const agentSettings = require('../agent-settings');
const chatpush = require('../chatpush');
const orchestratorDefault = require('./orchestrator');
const escalateTool = require('./tools/escalate-to-operator');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentDispatcher');

// Фраза-страховка, если модель эскалировала, не написав объявления о переводе.
const DEFAULT_HANDOVER_TEXT =
  'Передаю ваш диалог администратору клиники — он подключится с минуты на минуту 🤍';

// Инвариант «агент никогда не молчит»: если ход не дал НИ ОДНОЙ реплики (упёрся
// в лимит итераций, провайдер отвалился, БД легла) — клиент всё равно получает
// сообщение, а диалог уходит живому человеку. Инцидент 2026-07-19: ход завершился
// с replies=[], watermark уже сдвинут → ретрая не будет, клиент завис навсегда.
const DEFAULT_SILENT_FALLBACK_TEXT =
  'Секунду, уточняю детали — передаю ваш вопрос администратору клиники, он ответит вам с минуты на минуту 🤍';

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
  // Прогон уже идёт → перезапустим после него через флаг rerun; новый debounce-таймер
  // здесь не нужен (он выстрелил бы лишний повторный прогон и дубль-ответ клиенту).
  if (running.has(k)) { rerun.add(k); return; }

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
  const escalate = opts.escalate || defaultEscalate;

  // Гейт — ВНЕ общего try: его падение fail-closed (молчим). Мы не знаем, разрешён
  // ли номер, а страховочный ответ из catch написал бы тому, кому писать нельзя.
  let gate;
  try {
    gate = await settings.isAllowed(salonId, meta.phone);
  } catch (e) {
    logger.error(`dialog ${dialogKey} gate failed: ${e.message} — молчим (fail-closed)`);
    return;
  }
  if (!gate.allow) { logger.info(`gate skip ${dialogKey} (${gate.reason})`); return; }

  try {
    if (running.has(k)) { rerun.add(k); return; }
    running.add(k);
    try {
      // Стоп-темы грузим здесь (у диспетчера уже есть settings), чтобы не тащить
      // зависимость от БД в оркестратор. Отсутствие метода в моке → пустой список.
      const stopTopics = settings.loadStopTopicsSafe
        ? await settings.loadStopTopicsSafe(salonId) : [];
      const res = await orchestrator.runDialog(salonId, dialogKey,
        { ctx: { phone: meta.phone }, stopTopics });
      // Доставляем реплики, в т.ч. на ходе эскалации — это явное объявление о переводе.
      // Инвариант: при СВЕЖЕЙ эскалации клиент никогда не остаётся без сообщения.
      const replies = (res.replies || []).filter((t) => t && t.trim());
      if (res.alreadyEscalated) {
        // Диалог уже у оператора — бот молчит, не переотправляем объявление о переводе
        // на каждое последующее входящее (иначе фраза перевода спамит клиента).
      } else if (res.bookingFailed && !res.escalated) {
        // Запись не создалась (create_booking вернул ошибку), а бот сам не перевёл на
        // человека — типичная «секундочку» без результата. Не оставляем клиента с пустым
        // обещанием: передаём администратору и сообщаем об этом. Инцидент 2026-07-21.
        logger.warn(`dialog ${dialogKey}: create_booking не удался, бот не эскалировал — принудительный перевод на человека`);
        await handOverSilently(salonId, dialogKey, meta, send, escalate, 'create_booking не удался — запись не создана автоматически');
      } else if (res.escalated && replies.length === 0) {
        await send(meta, DEFAULT_HANDOVER_TEXT);
      } else if (replies.length === 0) {
        // Бот не смог ответить. Молчать нельзя — зовём человека и говорим об этом.
        logger.warn(`dialog ${dialogKey}: ход без реплик (exhausted=${!!res.exhausted}) — страховочный ответ + эскалация`);
        await handOverSilently(salonId, dialogKey, meta, send, escalate,
          res.exhausted ? 'агент исчерпал лимит инструментов без ответа' : 'агент не сформировал ответ');
      } else {
        for (const text of replies) await send(meta, text);
      }
    } finally {
      running.delete(k);
    }
    if (rerun.delete(k)) {
      logger.info(`dialog ${dialogKey}: отложенный прогон (сообщение пришло во время обработки)`);
      return process(salonId, dialogKey, meta, opts);
    }
  } catch (e) {
    logger.error(`dialog ${dialogKey} process failed: ${e.message}`);
    // Тот же инвариант на аварийном пути: упавший прогон не должен обернуться
    // тишиной в чате. Гейт сюда не попадает — он отсекается до running-блока.
    await handOverSilently(salonId, dialogKey, meta, send, escalate,
      `сбой обработки: ${e.message}`);
  }
}

// Отдать диалог человеку и предупредить клиента. Обе операции — best-effort:
// падение эскалации (БД) не должно съесть сообщение клиенту, и наоборот.
async function handOverSilently(salonId, dialogKey, meta, send, escalate, reason) {
  try {
    await escalate(salonId, dialogKey, reason);
  } catch (e) {
    logger.error(`dialog ${dialogKey}: эскалация не удалась (${e.message}) — клиенту всё равно отвечаем`);
  }
  try {
    await send(meta, DEFAULT_SILENT_FALLBACK_TEXT);
  } catch (e) {
    logger.error(`dialog ${dialogKey}: страховочное сообщение не ушло: ${e.message}`);
  }
}

// Пометить диалог эскалированным (та же запись, что делает инструмент агента).
async function defaultEscalate(salonId, dialogKey, reason) {
  return escalateTool.run(salonId, { reason }, { dialogKey });
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
