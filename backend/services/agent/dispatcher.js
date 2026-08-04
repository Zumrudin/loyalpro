'use strict';

const config = require('../../config');
const agentSettings = require('../agent-settings');
const chatpush = require('../chatpush');
const orchestratorDefault = require('./orchestrator');
const bookingEvents = require('./booking');
const pendingReplies = require('./pending-replies');
const dialogStateDefault = require('./dialog-state');
const authorship = require('../outgoing-authorship');
const escalateTool = require('./tools/escalate-to-operator');
const adminHours = require('./admin-hours');
const groupChat = require('./group-chat');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentDispatcher');

// Страховочные фразы перевода живут в admin-hours: вне окна присутствия
// администратора (AGENT_ADMIN_HOURS) они не обещают «с минуты на минуту» —
// ночью это ложь (аудит 2026-08-01). Вычисляем в момент отправки.
function adminOffNow() {
  return adminHours.isAdminOffHours(adminHours.nowHHMMMoscow(), config.AGENT_ADMIN_HOURS);
}

// Один PM2-процесс → in-memory состояние (спека [2]: дебаунс на один процесс).
const timers = new Map();   // key → { timer, meta }  (дебаунс серии)
const running = new Set();   // key диалогов в обработке (сериализация в процессе)
const rerun = new Set();     // пришло входящее, пока диалог обрабатывался

function keyOf(salonId, dialogKey) { return `${salonId}:${dialogKey}`; }

// Мила ведёт переписку только ЛИЧНО с клиентом: групповой чат отсекается и здесь,
// а не только в вебхуке — второй уровень защиты для любых будущих вызовов
// (дублировать нечего: сам список признаков живёт в одном месте, group-chat.js).
function isGroupDialog(dialogKey, meta) {
  return groupChat.isGroupChatId(dialogKey) || groupChat.isGroupMessage(meta);
}

// Вызывается из вебхука на каждое ВХОДЯЩЕЕ. Копит серию, запускает после тишины.
// opts (для тестов): { debounceMs, settings, orchestrator, send }.
function enqueue(salonId, dialogKey, meta, opts = {}) {
  if (isGroupDialog(dialogKey, meta)) {
    logger.info(`skip ${dialogKey}: групповой чат — агент отвечает только в личной переписке`);
    return;
  }
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
  if (isGroupDialog(dialogKey, meta)) {
    logger.info(`skip ${dialogKey}: групповой чат — агент отвечает только в личной переписке`);
    return;
  }
  const k = keyOf(salonId, dialogKey);
  const settings = opts.settings || agentSettings;
  const orchestrator = opts.orchestrator || orchestratorDefault;
  // Каждая успешно отправленная реплика запоминается в pending-replies: эхо
  // Chatpush приходит с задержкой (или не приходит вовсе), и без этого повторный
  // прогон не видит в транскрипте только что отправленный ответ — модель отвечает
  // на серию заново, с повторным приветствием (инцидент 2026-07-31).
  const rawSend = opts.send || defaultSend;
  // Журнал авторства: по нему вебхук отличит эхо ЭТОЙ реплики от сообщения,
  // которое администратор набрал руками в приложении Chatpush (там нужна пауза).
  const authorLog = opts.authorship || authorship;
  const send = async (m, text) => {
    const out = await rawSend(m, text);
    pendingReplies.remember(salonId, dialogKey, text);
    // Без await: доставка следующей реплики не должна ждать служебной записи, а
    // эхо приходит секундами-минутами позже вставки. remember сам не бросает.
    authorLog.remember(salonId, dialogKey, text, 'agent');
    return out;
  };
  const escalate = opts.escalate || defaultEscalate;
  const priorBookingFailure = opts.priorBookingFailure || defaultPriorBookingFailure;

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

  // Пауза «отвечал администратор» протухает на ОТКРЫТИИ окна расписания: если её
  // поставили до начала текущего окна, диалог возвращается боту. Настоящую
  // эскалацию Милы это не трогает — только operator_reply. Сбой не имеет права
  // ронять ход: не сняли паузу → оркестратор просто промолчит, как раньше.
  if (typeof gate.minutesSinceWindowStart === 'number') {
    try {
      const resumed = await (opts.dialogState || dialogStateDefault)
        .resumeOperatorPauseIfWindowReopened(salonId, dialogKey, gate.minutesSinceWindowStart);
      if (resumed) logger.info(`dialog ${dialogKey}: пауза оператора снята — открылось окно расписания`);
    } catch (e) {
      logger.warn(`dialog ${dialogKey}: не снять паузу оператора (${e.message})`);
    }
  }

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
      } else if (res.falseSuccess && !res.escalated) {
        // Бот отрапортовал «перенесла/отменила/записала», но пишущий инструмент не
        // отработал (ложный успех — пилот claude-haiku 2026-07-22). НЕ отправляем ложь
        // клиенту: гасим реплику и переводим на человека для реального оформления.
        logger.warn(`dialog ${dialogKey}: реплика утверждает выполнение без вызова пишущего инструмента — гашу ложь, перевод на человека`);
        await handOverSilently(salonId, dialogKey, meta, send, escalate, 'бот заявил о выполнении без вызова инструмента (возможный ложный успех)');
      } else if (res.bookingFailed && !res.escalated) {
        // Запись не создалась, а бот сам не перевёл на человека. Два исхода:
        //  • Восстановимый провал (bookingFailRecoverable): модель добросовестно
        //    переиграла — извинилась и предложила другое реально свободное время
        //    (не соврав об успехе). Доверяем ей и доставляем реплику БЕЗ перевода,
        //    НО только если это ПЕРВЫЙ провал в серии (иначе цикл неудачных слотов).
        //    Инцидент 2026-07-28: «время занято» уводило на администратора зря.
        //  • Иначе — пустая «секундочку», тишина, ложный успех или повторный провал:
        //    передаём администратору, чтобы клиент не завис. Инцидент 2026-07-21.
        const canRecover = res.bookingFailRecoverable
          && !(await priorBookingFailure(salonId, dialogKey));
        if (canRecover) {
          logger.info(`dialog ${dialogKey}: create_booking не удался, но бот переиграл (предложил другое время) — доставляю без перевода`);
          for (const text of replies) await send(meta, text);
        } else {
          logger.warn(`dialog ${dialogKey}: create_booking не удался, переигровки нет либо повторный провал — принудительный перевод на человека`);
          await handOverSilently(salonId, dialogKey, meta, send, escalate, 'create_booking не удался — запись не создана автоматически');
        }
      } else if (res.escalated) {
        // Свежая эскалация: клиент ОБЯЗАН услышать про перевод на администратора.
        // Модель могла ответить по делу («Спасибо, что предупредили»), но забыть
        // объявить перевод — тогда добавляем стандартную фразу детерминированно.
        for (const text of replies) await send(meta, text);
        const announced = replies.some(t => /администратор/i.test(t));
        if (!announced) await send(meta, adminHours.handoverText(adminOffNow()));
      } else if (replies.length === 0) {
        // Бот не смог ответить. Молчать нельзя — зовём человека и говорим об этом.
        logger.warn(`dialog ${dialogKey}: ход без реплик (exhausted=${!!res.exhausted}) — страховочный ответ + эскалация`);
        await handOverSilently(salonId, dialogKey, meta, send, escalate,
          res.exhausted ? 'агент исчерпал лимит инструментов без ответа' : 'агент не сформировал ответ');
      } else if (rerun.has(k) && !res.sideEffect) {
        // Пока модель думала, клиент дописал сообщение (оно пришло уже после
        // stale-check оркестратора) → черновик отвечает не на всю серию. Ход без
        // побочных эффектов безопасно выбросить: rerun ниже соберёт ОДИН ответ на
        // всё сразу. Иначе клиент получал два почти одинаковых ответа с повторным
        // приветствием (инцидент 2026-07-31). Ходы с side-effect (запись создана)
        // не выбрасываются — подтверждение обязано дойти.
        logger.info(`dialog ${dialogKey}: новое сообщение до отправки — выбрасываю устаревший черновик, отвечу одним сообщением`);
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
    // Инвариант «агент никогда не молчит»: ход без реплик или сбой — клиент всё
    // равно получает сообщение, а диалог уходит живому человеку (инцидент 2026-07-19).
    await send(meta, adminHours.silentFallbackText(adminOffNow()));
  } catch (e) {
    logger.error(`dialog ${dialogKey}: страховочное сообщение не ушло: ${e.message}`);
  }
}

// Пометить диалог эскалированным (та же запись, что делает инструмент агента).
async function defaultEscalate(salonId, dialogKey, reason) {
  return escalateTool.run(salonId, { reason }, { dialogKey });
}

// Был ли в этой серии УЖЕ провал записи (помимо текущего)? >1 booking_failed
// после последнего успеха → серия неудачных слотов, переигровку больше не даём —
// переводим на человека. Ограничивает восстановление одной попыткой.
async function defaultPriorBookingFailure(salonId, dialogKey) {
  const n = await bookingEvents.countBookingFailuresSinceSuccess(salonId, dialogKey);
  return n > 1;
}

// Отправка одной реплики обратно клиенту через chatpush.
async function defaultSend(meta, text) {
  const token = config.CHATPUSH.instanceToken;
  if (!token) { logger.error('CHATPUSH_INSTANCE_TOKEN not set — cannot reply'); return; }
  const delivery = await chatpush.sendMessage(token, {
    text,
    phone: meta.phone,
    dispatchRouting: [chatpush.replyRoutingFor(meta.channel)],
    replyToMessageId: meta.messageId,
  });
  // Chatpush доставляет из очереди и с многоминутной задержкой (эхо в webhook
  // приходит только по факту доставки) — без этого лога успешный ход неотличим
  // от зависшего до прихода эха. Инцидент-диагностика 2026-07-26.
  logger.info(`reply ${meta.phone || ''} принят в доставку: ${String(text).slice(0, 80)}`);
  return delivery;
}

// Сброс in-memory состояния — только для тестов.
function _reset() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear(); running.clear(); rerun.clear();
}

module.exports = { enqueue, process, defaultSend, _reset };
