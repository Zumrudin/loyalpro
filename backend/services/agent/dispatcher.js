'use strict';

const config = require('../../config');
const agentSettings = require('../agent-settings');
const chatpush = require('../chatpush');
const { recipientParams } = require('../chat');
const orchestratorDefault = require('./orchestrator');
const bookingEvents = require('./booking');
const pendingReplies = require('./pending-replies');
const dialogStateDefault = require('./dialog-state');
const authorship = require('../outgoing-authorship');
const escalateTool = require('./tools/escalate-to-operator');
const adminHours = require('./admin-hours');
const groupChat = require('./group-chat');
const toolEventsDefault = require('./tool-events');
const chatPersist = require('../chat-persist');
const deliveryWatchdog = require('./delivery-watchdog');
const priceListData = require('./price-list-data');
const followupQueueDefault = require('./followup-queue');
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
  // Журнал tool-цикла: оркестратор флашит события хода с delivered=null, вердикт
  // «пациент это видел» знает только диспетчер — он и проставляет его ниже.
  const toolEventsLog = opts.toolEvents || toolEventsDefault;
  // Своя реплика в «Чате» и журнал отправок — оба best-effort и оба не имеют
  // права уронить доставку, поэтому вызовы обёрнуты try/catch ЗДЕСЬ, а не только
  // внутри реализаций (инжектированный мок тоже не должен ломать серию).
  const persistOwn = opts.persistOwn || defaultPersistOwn;
  const deliveryLog = opts.deliveryLog || deliveryWatchdog;
  // Отправка вложений (фото прайса). Отдельная точка от send: у файла нет текста,
  // поэтому ни pendingReplies, ни журнал авторства ему не нужны — эхо с текстом
  // не придёт. Персист в «Чат» нужен: иначе в админке диалог выглядит как
  // «клиент попросил прайс — Мила молчит».
  const rawSendFile = opts.sendFile || defaultSendFile;
  const persistOwnFile = opts.persistOwnFile || defaultPersistOwnFile;
  const sendAttachment = async (m, att) => {
    const out = await rawSendFile(m, att);
    if (!out) return;
    try { await persistOwnFile(salonId, dialogKey, m, att, out); }
    catch (e) { logger.warn(`dialog ${dialogKey}: фото прайса не легло в «Чат» (${e.message})`); }
  };
  const send = async (m, text) => {
    const out = await rawSend(m, text);
    pendingReplies.remember(salonId, dialogKey, text);
    // Без await: доставка следующей реплики не должна ждать служебной записи, а
    // эхо приходит секундами-минутами позже вставки. remember сам не бросает.
    authorLog.remember(salonId, dialogKey, text, 'agent');
    try { await persistOwn(salonId, dialogKey, m, text, out); }
    catch (e) { logger.warn(`dialog ${dialogKey}: своя реплика не легла в «Чат» (${e.message})`); }
    try { await deliveryLog.record(salonId, dialogKey, m, text, out); }
    catch (e) { logger.warn(`dialog ${dialogKey}: отправка не попала в журнал доставок (${e.message})`); }
    return out;
  };
  const escalate = opts.escalate || defaultEscalate;
  const priorBookingFailure = opts.priorBookingFailure || defaultPriorBookingFailure;
  // Очередь ожидания ответа клиента — та же форма инжекции, что у остальных
  // side-effect зависимостей выше: без неё проводку нельзя проверить тестом.
  const followupQueue = opts.followupQueue || followupQueueDefault;

  // Вердикт для журнала инструментов: видел ли пациент реплики МОДЕЛИ этого хода.
  // turnId известен только со штатного результата runDialog (ранние выходы и
  // падение прогона его не отдают); пишет вердикт finally ниже — в том числе
  // когда отправка упала на середине серии.
  let turnId = null;
  let deliveredReplies = false;
  // ЕДИНАЯ точка доставки реплик модели. ЗАЧЕМ хелпер, а не цикл по месту: веток
  // отправки в process() уже три, и файл обрастает новой примерно после каждого
  // инцидента. Забытый рядом с четвёртым циклом флаг дал бы МОЛЧАЛИВЫЙ false —
  // Мила повторила бы пациенту уже сказанное (включая приветствие), то есть ровно
  // тот инцидент, ради которого журнал и заводится. Ни компилятор, ни тесты этого
  // не поймают, поэтому флаг выставляет сама естественная запись отправки.
  const deliverReplies = async (list, attachments) => {
    for (const text of list) await send(meta, text);
    // РАЗМЕН (находка C3 ревью): deliveredReplies считается ТОЛЬКО по тексту,
    // а не по фото ниже. Это осознанно, а не забытая деталь: markDelivered —
    // вердикт на ВЕСЬ ход в целом (см. finally в process()), и если бы упавшее
    // фото гасило его до false, мы стёрли бы из памяти всё остальное, что
    // модель ПОКАЗАЛА пациенту текстом в этом же ходу (слоты, цены) — на
    // следующем ходу Мила начала бы повторяться. Цена размена: если ВСЕ фото
    // упали, а текст ушёл, следующий ход всё равно прочитает в «ЖУРНАЛЕ ТВОИХ
    // ДЕЙСТВИЙ» «отправила пациенту фото прайс-листа» и может на него
    // сослаться («я же присылала прайс»), хотя фото не дошло. Разбор такого
    // случая опирается на лог ниже (fileUrl+категория+причина) — правь его
    // одновременно с любой правкой этого места.
    deliveredReplies = list.length > 0;
    // Вложения ВНУТРИ хелпера намеренно: веток, где реплики не доставляются,
    // уже пять, и отдельный вызов рядом с ними рано или поздно забыли бы —
    // фото ушло бы к погашенной лжи или к выброшенному черновику.
    // Сбой одного файла не отменяет остальные и не роняет ход: текст доставлен.
    for (const att of (attachments || [])) {
      try { await sendAttachment(meta, att); }
      catch (e) { logger.warn(`dialog ${dialogKey}: фото прайса «${att.category}» (${att.fileUrl}) не ушло (${e.message})`); }
    }
  };

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
    // Вынесена из try: нужна в finally, чтобы поставить ожидание ответа клиента
    // (followupQueue.shouldAwaitReply читает writeSucceeded/escalated/silent).
    let res = null;
    try {
      // Стоп-темы грузим здесь (у диспетчера уже есть settings), чтобы не тащить
      // зависимость от БД в оркестратор. Отсутствие метода в моке → пустой список.
      const stopTopics = settings.loadStopTopicsSafe
        ? await settings.loadStopTopicsSafe(salonId) : [];
      res = await orchestrator.runDialog(salonId, dialogKey,
        { ctx: { phone: meta.phone, channel: meta.channel }, stopTopics });
      // Доставляем реплики, в т.ч. на ходе эскалации — это явное объявление о переводе.
      // Инвариант: при СВЕЖЕЙ эскалации клиент никогда не остаётся без сообщения.
      const replies = (res.replies || []).filter((t) => t && t.trim());
      turnId = res.turnId || null;
      if (res.alreadyEscalated) {
        // Диалог уже у оператора — бот молчит, не переотправляем объявление о переводе
        // на каждое последующее входящее (иначе фраза перевода спамит клиента).
      } else if (res.falseSuccess && !res.escalated) {
        // Бот отрапортовал «перенесла/отменила/записала», но пишущий инструмент не
        // отработал (ложный успех — пилот claude-haiku 2026-07-22). НЕ отправляем ложь
        // клиенту: гасим реплику и переводим на человека для реального оформления.
        // Текст погашенной реплики пишем в лог ЦЕЛИКОМ до потолка: больше его
        // нет нигде — в БД ложатся только отправленные сообщения, а черновик
        // умирает здесь. Разбор инцидента 2026-08-06 (79200255591) упёрся ровно
        // в это: guard залогировал факт, и какую именно ложь модель сочинила,
        // восстановить было нечем. Переводы строк схлопываем — многострочная
        // реплика иначе рвёт лог на куски без префикса.
        const draft = replies.join(' | ').replace(/\s+/g, ' ').slice(0, 500);
        logger.warn(`dialog ${dialogKey}: реплика утверждает выполнение без вызова пишущего инструмента (${res.falseSuccessKind || 'unknown'}) — гашу ложь, перевод на человека: «${draft}»`);
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
          await deliverReplies(replies, res.attachments);
        } else {
          logger.warn(`dialog ${dialogKey}: create_booking не удался, переигровки нет либо повторный провал — принудительный перевод на человека`);
          await handOverSilently(salonId, dialogKey, meta, send, escalate, 'create_booking не удался — запись не создана автоматически');
        }
      } else if (res.escalated) {
        // Свежая эскалация: клиент ОБЯЗАН услышать про перевод на администратора.
        // Модель могла ответить по делу («Спасибо, что предупредили»), но забыть
        // объявить перевод — тогда добавляем стандартную фразу детерминированно.
        await deliverReplies(replies, res.attachments);
        // handoverText — фиксированная системная фраза, а не факт хода: она уходит
        // ПОСЛЕ хелпера и на вердикт delivered намеренно не влияет.
        // Признак живёт в admin-hours рядом с самими фразами перевода: копия
        // регулярки здесь молча разъехалась бы с детерминированными репликами,
        // которые перевод объявляют сами (visit-rating.buildApology).
        const announced = replies.some(t => adminHours.HANDOVER_ANNOUNCED_RE.test(t));
        if (!announced) await send(meta, adminHours.handoverText(adminOffNow()));
      } else if (res.silent) {
        // Оркестратор РЕШИЛ промолчать, а не не смог: завершающая вежливость
        // (closing.js) либо высокая оценка визита, на которую благодарность
        // шлёт сама клиника (visit-rating). Конкретную причину пишет он сам —
        // здесь общая строка. Ветка обязана стоять ВЫШЕ соседней: там ноль
        // реплик = отказ, и на «спасибо» пациент получил бы «передаю администратору».
        logger.info(`dialog ${dialogKey}: молчим — отвечать не на что`);
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
        await deliverReplies(replies, res.attachments);
      }
    } finally {
      running.delete(k);
      // Вердикт журнала инструментов. Fire-and-forget (markDelivered сам глотает
      // сбои БД) — не критичный путь, ждать его доставка реплик не должна.
      // В finally, а не после цепочки if/else: упавшая на середине серии отправка
      // уходит в общий catch, а вердикт нужен и там. Ветки, где реплики модели не
      // ушли, оставляют false — их факты пациенту не показаны: falseSuccess,
      // bookingFailed без переигровки, ход без реплик (handOverSilently во всех
      // трёх шлёт только страховочный текст), выброшенный rerun-черновик и
      // молчание на alreadyEscalated.
      if (turnId) void toolEventsLog.markDelivered(turnId, deliveredReplies);
      // Ожидание ответа клиента. ТА ЖЕ точка, что и вердикт памяти, и по той же
      // причине: веток отправки в process() уже пять, и отдельный вызов рядом с
      // каждой рано или поздно забыли бы. Best-effort и без await — строка
      // очереди не должна задерживать возврат из хода.
      if (followupQueue.shouldAwaitReply({
        delivered: deliveredReplies,
        writeSucceeded: res && res.writeSucceeded,
        escalated: res && res.escalated,
        silent: res && res.silent,
      })) {
        // Promise.resolve().then(...) ОБЯЗАТЕЛЕН — не упрощать в прямой вызов
        // settings.getSettings(salonId).then(...): прямой вызов, если метода нет
        // (мок без getSettings, будущий рефакторинг), бросает СИНХРОННО ДО
        // построения цепочки — мимо .catch ниже, в общий catch process(), а тот
        // шлёт пациенту лишнюю фразу «передаю администратору» поверх уже
        // доставленного ответа. Обёртка переносит любой синхронный бросок внутрь
        // цепочки промисов, и он становится отклонением, видимым в .catch.
        // Якорь берём ЗДЕСЬ, а не внутри schedule(): между этой точкой и вставкой
        // строки лежит поход в БД за настройками, и за это время клиент успевает
        // ответить. Тогда вебхук гасить ещё нечего (строки нет), а строка ляжет с
        // якорём ПОЗЖЕ его сообщения — воркер не увидит входящего «после якоря» и
        // напомнит о себе тому, кто уже ответил. Якорь момента ДОСТАВКИ закрывает
        // это окно: ответ клиента гарантированно свежее его.
        const anchorAt = new Date();
        void Promise.resolve()
          .then(() => settings.getSettings(salonId))
          .then(s => followupQueue.schedule(salonId, dialogKey, meta, s, { now: anchorAt }))
          .catch(e => logger.warn(`dialog ${dialogKey}: ожидание ответа не поставлено (${e.message})`));
      }
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
  const params = recipientParams(meta.channel, {
    phone: meta.phone,
    chat_id: meta.chatId,
    isGroup: groupChat.isGroupMessage(meta),
  });
  if (!params) {
    logger.error(`нет получателя для ответа ${meta.channel} phone=${meta.phone || ''} chatId=${meta.chatId || ''}`);
    return null;
  }
  const delivery = await chatpush.sendMessage(token, {
    text,
    ...params,
    replyToMessageId: meta.messageId,
  });
  // Chatpush доставляет из очереди и с многоминутной задержкой (эхо в webhook
  // приходит только по факту доставки) — без этого лога успешный ход неотличим
  // от зависшего до прихода эха. Инцидент-диагностика 2026-07-26.
  //
  // delivery.id в строке ОБЯЗАТЕЛЕН: `meta.status=success` означает лишь «принято
  // в очередь», и единственный способ узнать судьбу сообщения постфактум —
  // `GET /api/v1/delivery/:id`. Инцидент 2026-08-09 (79773115566) разбирался
  // вслепую именно потому, что id нигде не сохранялся: чужие id отдают 404, а
  // свои разрежены среди глобальной нумерации Chatpush (~80 id в минуту).
  logger.info(`reply ${meta.phone || ''} принят в доставку (delivery=${delivery && delivery.id != null ? delivery.id : 'n/a'}): ${String(text).slice(0, 80)}`);
  return delivery;
}

// Своя реплика в «Чате». tdlib/max эхо шлют исправно — их строку кладёт вебхук;
// у WhatsApp эхо может не прийти вовсе, и тогда в админке диалог выглядит как
// «клиент написал, Мила молчит» ровно в тот момент, когда разбираться и надо
// (инцидент 2026-08-09). Остальные наши отправки — автоуведомления, «Забота»,
// напоминания, ручной ответ оператора — персистят себя так же и давно.
async function defaultPersistOwn(salonId, dialogKey, meta, text, delivery) {
  if (!delivery || delivery.id == null) return;
  if (meta.channel !== 'whatsapp') return;
  await chatPersist.persistWhatsappOutgoing(salonId, {
    delivery, phone: meta.phone, chatId: meta.chatId,
    text, msgType: 'text', authoredBy: 'agent',
  });
}

// Отправка одного фото прайса. Файл читается price-list-data (единственное
// место, где живёт путь к uploads и гейт «только /uploads/»).
async function defaultSendFile(meta, att) {
  const token = config.CHATPUSH.instanceToken;
  if (!token) { logger.error('CHATPUSH_INSTANCE_TOKEN not set — cannot send price photo'); return null; }
  const params = recipientParams(meta.channel, {
    phone: meta.phone,
    chat_id: meta.chatId,
    isGroup: groupChat.isGroupMessage(meta),
  });
  if (!params) {
    logger.error(`нет получателя для фото ${meta.channel} phone=${meta.phone || ''} chatId=${meta.chatId || ''}`);
    return null;
  }
  const buf = await priceListData.readPhotoBuffer(att.fileUrl);
  if (!buf) { logger.warn(`фото прайса не найдено на диске: ${att.fileUrl}`); return null; }
  // Имя обязано содержать расширение (требование Chatpush); кириллицу не шлём.
  const ext = (String(att.fileName || '').match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0];
  const delivery = await chatpush.sendFile(token, {
    fileName: `price_${Date.now()}${ext}`,
    type: 'image',
    ...params,
  }, buf, att.mimeType);
  logger.info(`price photo ${meta.phone || ''} принято в доставку (delivery=${delivery && delivery.id != null ? delivery.id : 'n/a'}): ${att.category}`);
  return delivery;
}

// Своё фото в «Чате». Как и у текста: эхо WhatsApp может не прийти вовсе.
// fileUrl — реальный att.fileUrl (например /uploads/pricelist_1_c12_...jpg), НЕ
// null: файл отдаётся статикой, фронт чата (_chatSafeUrl в chat.js) корректно
// рендерит корневые относительные пути ссылкой «📎 Вложение». С null админ видел
// в переписке безликое «Вложение» без возможности открыть сам файл.
async function defaultPersistOwnFile(salonId, dialogKey, meta, att, delivery) {
  if (!delivery || delivery.id == null) return;
  if (meta.channel !== 'whatsapp') return;
  await chatPersist.persistWhatsappOutgoing(salonId, {
    delivery, phone: meta.phone, chatId: meta.chatId,
    text: `📎 Прайс-лист: ${att.category}`,
    msgType: 'image', fileUrl: att.fileUrl, mimeType: att.mimeType, authoredBy: 'agent',
  });
}

// Сброс in-memory состояния — только для тестов.
function _reset() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear(); running.clear(); rerun.clear();
}

module.exports = {
  enqueue, process, defaultSend, defaultPersistOwn,
  defaultSendFile, defaultPersistOwnFile, _reset,
};
