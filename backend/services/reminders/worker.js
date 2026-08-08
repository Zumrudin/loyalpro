'use strict';
// Воркер напоминаний о повторном визите. Аренда due-строк как в
// notification- и care-воркерах (FOR UPDATE SKIP LOCKED + attempts при
// аренде), затем на каждую строку: детерминированные гейты → бонусы →
// рендер текста → отправка → персист.
//
// Доставка AT-MOST-ONCE: пропущенное напоминание дешевле дубля живому
// клиенту. Отсюда захват строки условным UPDATE перед любыми side-effect'ами.
//
// Все внешние зависимости инжектируются — юнит-тесты без БД и сети.

const config = require('../../config');
const { db: realDb } = require('../../db');
const chatpush = require('../chatpush');
const { persistWhatsappOutgoing } = require('../chat-persist');
const agentSettings = require('../agent-settings');
const { getProvider } = require('../agent/providers');
const history = require('../agent/history');
const pendingReplies = require('../agent/pending-replies');
const replyGuard = require('../agent/reply-guard');
const salonNames = require('../../utils/salon-names');
const authorship = require('../outgoing-authorship');
const notifications = require('../notifications');
const dailyLimit = require('../messaging/daily-limit');
const sendPacing = require('../messaging/send-pacing');
const chatEvents = require('../chat-events');
const careContext = require('../care/context');
const { plusOneDay } = require('../care/schedule');
const { hasFutureMatchingBooking } = require('./eligibility');
const { renderReminderText, pickTierText } = require('./template');
const { pickTier } = require('./tiers');
const bonusSvc = require('./bonus');
const { buildReminderPrompt } = require('./reminder-prompt');
const { parseCareDecision } = require('../care/decision');
const { createLogger } = require('../../logger');

const log = createLogger('RemindersWorker');

const WORKER_TICK_MS      = 60000;
const MAX_ATTEMPTS        = 3;
const RETRY_BACKOFF_S     = 120;
// Таймаут care-прохода LLM в режиме free (buildText): зависший провайдер не
// должен держать строку 'scheduled' вечно. 60с < backoff аренды 120с (тот же
// запас, что в care-воркере) — таймаут-ретрай не пересечётся с ещё живым
// прошлым вызовом в окне аренды. Захват строки (SET status='sent') стоит
// ПОСЛЕ этого вызова (вплотную перед sendMessage) — запас в 60с покрывает и
// сам LLM-вызов, и остальные шаги между арендой (LEASE_SQL проставляет
// last_attempt_at) и капчуром (isAllowed/YClients-проверки/applyBonus), но
// это НЕ железная гарантия против повторной аренды той же строки ДРУГИМ
// процессом при горизонтальном масштабировании воркера — только запас на
// один процесс с внутрипроцессным guard'ом _tickInFlight (текущий деплой:
// pm2 fork, один инстанс). При переходе на несколько инстансов нужен либо
// явный distributed lock, либо увеличение backoff'а с новым запасом.
const LLM_TIMEOUT_MS      = 60000;
// Предел терпения к паузе администратора: она обычно снимается вечерним
// sweep'ом, но ждать бесконечно нельзя — напоминание протухнет по смыслу.
const MAX_OPERATOR_DEFERS = 3;

const SEND_STATUSES = new Set(['scheduled', 'sent', 'skipped', 'cancelled', 'failed']);

// Явный признак исхода processOne «сработала пауза темпа»: пауза — гейт уровня
// САЛОНА, и processTick обязан отличить её от любого другого откладывания,
// чтобы не трогать остальные строки того же салона в этом же тике (см.
// комментарий у processTick). Возвращается объектом, а не булевым: processOne
// в остальных исходах возвращает undefined, и явное поле читается на месте
// вызова без догадок.
const RESULT_PACED = Object.freeze({ pacePaused: true });

// Маркер «[сообщение администратора клиники]» предназначен основному агенту:
// его промпт знает, что с ним делать, а care-промпт (который мы переиспользуем
// в режиме free) — нет, и пометка ушла бы клиенту дословно. Срезаем с начала
// КАЖДОЙ строки: реплики серии в транскрипте склеены через '\n'.
const OPERATOR_MARK_PREFIX = `${history.OPERATOR_MARK} `;
function stripOperatorMark(text) {
  return String(text || '')
    .split('\n')
    .map((line) => (line.startsWith(OPERATOR_MARK_PREFIX) ? line.slice(OPERATOR_MARK_PREFIX.length) : line))
    .join('\n');
}

// yclients_card_type_id ОБЯЗАТЕЛЕН (см. комментарий у applyBonus ниже) —
// один SELECT на боевой и на сухой путь, чтобы поля не разъехались.
async function loadBonusSalon(salonId) {
  return realDb.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token,
            yclients_card_type_id
       FROM salons WHERE id=$1`, [salonId]);
}

const defaultDeps = {
  db: realDb,
  // ignoreSchedule: ночное окно Милы на плановые напоминания не
  // распространяется — время задаёт сам салон в правиле. Чёрный список,
  // режим whitelist и тумблер агента продолжают действовать.
  isAllowed: (salonId, phone) => agentSettings.isAllowed(salonId, phone, { ignoreSchedule: true }),
  agentGloballyEnabled: () => !!config.CHATPUSH.agentEnabled,
  dialogStatus: async (salonId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT status FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [salonId, phone]);
    return r ? r.status : null;
  },
  isMuted: async (ruleId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT 1 FROM reminder_suppressions WHERE rule_id=$1 AND phone=$2 AND muted=TRUE`,
      [ruleId, phone]);
    return !!r;
  },
  // source: 'auto' (по умолчанию, отправлено штатно) | 'manual' — ручной
  // отказ клиента (action='stop_program' care-прохода в режиме free).
  // enroll.js снимает флаг автоматически при следующем визите ТОЛЬКО у
  // source='auto' — 'manual' держится, пока не снимет человек, иначе клиент,
  // попросивший не писать, был бы переподписан первым же визитом.
  mute: async (salonId, ruleId, phone, reason, source = 'auto') => {
    await realDb.query(
      `INSERT INTO reminder_suppressions (salon_id, rule_id, phone, muted, reason, source, muted_at, updated_at)
       VALUES ($1,$2,$3,TRUE,$4,$5,NOW(),NOW())
       ON CONFLICT (rule_id, phone) DO UPDATE
         SET muted=TRUE, reason=$4, source=$5, muted_at=NOW(), reset_at=NULL, updated_at=NOW()`,
      [salonId, ruleId, phone, reason, source]);
  },
  // Тот же механизм, что care-воркер (services/care/worker.js) и
  // tools/escalate-to-operator.js: status='escalated' + emitAgentStatus
  // (красный чат сверху списка немедленно). Upsert, а не UPDATE: клиент мог
  // никогда не писать агенту — строки agent_dialogs у него ещё нет.
  escalateDialog: async (salonId, phone, reason) => {
    await realDb.query(
      `INSERT INTO agent_dialogs (salon_id, dialog_key, status, escalated_reason)
       VALUES ($1,$2,'escalated',$3)
       ON CONFLICT (salon_id, dialog_key) DO UPDATE
         SET status='escalated', escalated_reason=$3, updated_at=now()`,
      [salonId, phone, reason]);
    await realDb.query(
      `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload)
       VALUES ($1,$2,'escalated','reminders_worker',$3)`,
      [salonId, phone, JSON.stringify({ reason })]);
    chatEvents.emitAgentStatus(salonId, phone, 'escalated', reason);
  },
  sentTodayExists: (salonId, phone) => dailyLimit.sentTodayExists(realDb, salonId, phone),
  lastPlannedSendAt: (salonId) => sendPacing.lastPlannedSendAt(realDb, salonId),
  loadClientRecords: careContext.loadClientRecords,
  getCatMap: async (salonId) => {
    const salon = await realDb.one(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
         FROM salons WHERE id=$1`, [salonId]);
    return notifications.getServiceCategoryMap(salon);
  },
  // yclients_card_type_id ОБЯЗАТЕЛЕН в этом SELECT: bonus.applyBonus выбирает
  // карту СТРОГО по типу, настроенному в салоне (как services/loyalty.js и
  // routes/clients.js), а не «у кого больше баланс». Без этого поля
  // applyBonus детерминированно возвращает no_bonus — начисления не будет
  // НИКОГДА, молча.
  applyBonus: async (salonId, ycClientId, tiers, ruleTitle) => {
    const salon = await loadBonusSalon(salonId);
    return bonusSvc.applyBonus(salon, ycClientId, tiers, ruleTitle);
  },
  // Сухой прогон бонусов для ТЕСТОВОЙ отправки: баланс карты читается
  // по-настоящему и ступень выбирается по нему (иначе тест не показал бы, что
  // именно начислилось бы и каким текстом), но сама транзакция подменена
  // пустышкой. Начисление необратимо, поэтому боевой путь включается только
  // явным согласием администратора (opts.accrue).
  applyBonusDry: async (salonId, ycClientId, tiers, ruleTitle) => {
    const salon = await loadBonusSalon(salonId);
    const r = await bonusSvc.applyBonus(salon, ycClientId, tiers, ruleTitle,
      { accrue: async () => {} });
    // txnOk=true означало бы «транзакция прошла» — её не было вовсе.
    return { ...r, txnOk: null, note: 'ТЕСТ: бонусы РЕАЛЬНО НЕ начислялись (сухой прогон)' };
  },
  loadNameDictionary: (salonId) => salonNames.load(salonId).catch(() => null),
  loadTranscript: (salonId, key, opts) => history.loadTranscript(salonId, key, opts),
  createMessage: (req, opts) => getProvider().createMessage(req, opts),
  lintReply: replyGuard.lintReply,
  hardViolations: replyGuard.hardViolations,
  sendMessage: (payload) => chatpush.sendMessage(config.CHATPUSH.instanceToken, payload),
  lastIncomingChannel: notifications.lastIncomingChannel,
  rememberPending: async (salonId, key, text) => {
    pendingReplies.remember(salonId, key, text);
    await authorship.remember(salonId, key, text, 'system');
  },
  persistWhatsapp: (salonId, { delivery, phone, text }) =>
    persistWhatsappOutgoing(salonId, { delivery, phone, chatId: null, text, msgType: 'text' }),
  log,
};

async function markRow(db, id, status, reason) {
  if (!SEND_STATUSES.has(status)) throw new Error(`bad status: ${status}`);
  await db.query(
    `UPDATE reminder_queue SET status='${status}', decision_reason=$2 WHERE id=$1`,
    [id, reason || null]);
}

/**
 * Отложить строку на сутки. НЕ терминально: строка остаётся scheduled и видна
 * в интерфейсе, бюджет попыток обнуляется. База сдвига — max(scheduled_at,
 * now()), чтобы просроченная строка уехала в будущее одним шагом, а не по дню
 * за тик. bumpDefers — только для паузы оператора (у остальных откладываний
 * предела нет: выключенный агент и анти-спам пройдут сами).
 */
async function deferRow(db, row, reason, bumpDefers = false) {
  const base = Math.max(new Date(row.scheduled_at || Date.now()).getTime(), Date.now());
  await db.query(
    `UPDATE reminder_queue
        SET scheduled_at=$2, attempts=0, last_attempt_at=NULL, decision_reason=$3
            ${bumpDefers ? ', defers = reminder_queue.defers + 1' : ''}
      WHERE id=$1`,
    [row.id, plusOneDay(new Date(base)), reason]);
}

/**
 * Отложить строку на N минут (в отличие от deferRow — на сутки). Для причин,
 * которые проходят сами через минуты: пауза темпа между сообщениями. Сутки
 * тут были бы абсурдны — пауза измеряется минутами, а строка протухла бы.
 *
 * attempts НЕ обнуляются, а откатываются РОВНО на одну — ту, что добавила
 * аренда (LEASE_SQL инкрементит attempts у каждой выданной строки). Обнуление
 * стирало бы и НАСТОЯЩИЕ провалы отправки: ветка сбоя считает
 * final = row.attempts >= MAX_ATTEMPTS, и одного откладывания темпом между
 * двумя провалами (в активном салоне это норма — счётчик темпа общий на три
 * очереди) хватало, чтобы строка с мёртвым каналом крутилась вечно, каждый
 * круг оплачивая LLM-проход в режиме free. Просто «не трогать» тоже нельзя:
 * тогда три откладывания темпом сжигали бы бюджет попыток ни за что.
 *
 * defers не трогаются — предела у паузы темпа нет по построению (она всегда
 * проходит), а на defers висит MAX_OPERATOR_DEFERS.
 *
 * AND status='scheduled' — строку могли отменить прямо во время прогона
 * (вебхук нового визита перепланировал напоминание): воскресить её этот
 * UPDATE не мог бы, но затёр бы её decision_reason своим.
 */
async function deferRowMinutes(db, row, minutes, reason) {
  const mins = Math.max(1, Math.ceil(Number(minutes) || 1));
  await db.query(
    `UPDATE reminder_queue
        SET scheduled_at = NOW() + make_interval(mins => $2),
            attempts = GREATEST(attempts - 1, 0), last_attempt_at = NULL,
            decision_reason = $3
      WHERE id = $1 AND status = 'scheduled'`,
    [row.id, mins, reason]);
}

// Пауза между плановыми сообщениями. Дефолт совпадает со схемой
// (reminder_rules.send_interval_min DEFAULT 3) и с parseRuleBody.
const DEFAULT_SEND_INTERVAL_MIN = 3;

/**
 * Интервал темпа для строки. Явный 0 — законное «без паузы». А вот
 * ОТСУТСТВИЕ или мусор — не ноль: Number(null|undefined|'') дал бы 0, то есть
 * тихо выключил бы защиту от пачки. Такое значение означает рассинхрон схемы
 * с кодом (строка арендована сборкой без колонки) — берём дефолт и ГРОМКО
 * сообщаем, а не молча шлём подряд.
 */
function resolveIntervalMin(row, logger) {
  const raw = row.send_interval_min;
  if (raw === undefined || raw === null || raw === '') {
    logger.warn(`row #${row.id}: send_interval_min отсутствует — беру дефолт ${DEFAULT_SEND_INTERVAL_MIN} мин`);
    return DEFAULT_SEND_INTERVAL_MIN;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(`row #${row.id}: send_interval_min битый (${JSON.stringify(raw)}) — беру дефолт ${DEFAULT_SEND_INTERVAL_MIN} мин`);
    return DEFAULT_SEND_INTERVAL_MIN;
  }
  return n;
}

/**
 * Решение по напоминанию: strict — всегда {action:'send', text, reason:null}
 * (шаблон детерминирован). free — Мила решает по заготовке смысла промптом
 * напоминаний, и решение может быть 'send'/'skip'/'escalate'/'stop_program'
 * (см. care/decision.js) — вызывающий обязан разобрать ВСЕ варианты, а не
 * только 'send': промпт обещает пациенту эскалацию при осложнении и
 * прекращение цепочки по просьбе «не пишите мне», и оба обещания нужно
 * реально выполнить, а не тихо погасить сообщением «текст напоминания пуст».
 */
async function buildText(row, bonus, deps) {
  const services = Array.isArray(row.anchor_services) ? row.anchor_services : [];
  const days = row.anchor_visit_at
    ? Math.round((Date.now() - new Date(row.anchor_visit_at).getTime()) / 86400000)
    : null;
  const tier = pickTier(bonus.balanceBefore, row.bonus_tiers);
  const tplCtx = {
    name: row.client_name,
    nameDictionary: await deps.loadNameDictionary(row.salon_id),
    service: services.map(s => s.title).filter(Boolean).join(', '),
    staff: row.anchor_staff_name || '',
    days,
    accrued: bonus.accrued || null,
    balance: bonus.balanceBefore,
    salon: row.salon_name,
  };
  // Ступень применяется, только если бонусная часть реально состоялась:
  // при 'no_bonus' уходит базовый текст правила без единого слова о бонусах.
  const raw = bonus.tier === 'no_bonus' ? String(row.rule_text || '')
                                        : pickTierText(tier, row.rule_text);

  if (row.text_mode !== 'free') {
    return { action: 'send', text: renderReminderText(raw, tplCtx), reason: null };
  }

  // free: заготовка смысла (уже с подставленными цифрами) уходит в СОБСТВЕННЫЙ
  // промпт напоминаний. Care-промпт («плановое касание заботы после визита, это
  // НЕ продажа») тут стоял до 08.08.2026 и давал систематический skip: любая
  // живая переписка читалась как «не пиши поверх» — измерено, см. шапку
  // services/reminders/reminder-prompt.js.
  const transcript = await deps.loadTranscript(row.salon_id, row.phone, { limit: 15 })
    .catch(() => ({ messages: [] }));
  const { system, user } = buildReminderPrompt({
    salonName: row.salon_name,
    clientName: row.client_name,
    nameDictionary: tplCtx.nameDictionary,
    rule: { title: row.rule_title, intent_text: renderReminderText(raw, tplCtx) },
    anchor: { staff_name: row.anchor_staff_name, visit_at: row.anchor_visit_at, services },
    transcript: (transcript.messages || []).map(m => ({
      direction: m.role === 'user' ? 'incoming' : 'outgoing',
      // stripOperatorMark — промпт (ни этот, ни care) про пометку администратора
      // не знает и отдал бы её клиенту дословно в тексте.
      text: stripOperatorMark(typeof m.content === 'string' ? m.content
        : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join(' ') : '')),
    })).filter(m => m.text),
  });
  let resp, timer;
  try {
    resp = await Promise.race([
      deps.createMessage({ system, messages: [{ role: 'user', content: user }] }, {}),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`reminder LLM timeout ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      }),
    ]);
  } finally { clearTimeout(timer); }
  // parseCareDecision уже возвращает форму {action, text?, reason, status?} —
  // ровно то, что нужно вызывающему; отдельного маппинга не требуется.
  return parseCareDecision(resp && resp.text);
}

async function processOne(row, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const { db } = d;
  const sid = row.salon_id;
  let delivered = false;
  let terminal = false;

  const finish = async (status, reason) => { await markRow(db, row.id, status, reason); terminal = true; };

  try {
    // ── детерминированные гейты ────────────────────────────────
    if (!row.rule_enabled) return finish('skipped', 'правило выключено');
    if (!d.agentGloballyEnabled()) {
      await deferRow(db, row, 'отложено: агент выключен (env)');
      return;
    }
    const gate = await d.isAllowed(sid, row.phone);
    if (!gate.allow) {
      if (gate.reason === 'outside-schedule') {
        d.log.warn(`row #${row.id}: гейт вернул outside-schedule вопреки ignoreSchedule — откладываю`);
        await deferRow(db, row, 'отложено: вне окна расписания агента');
        return;
      }
      return finish('skipped', `гейт Милы: ${gate.reason}`);
    }
    if (await d.dialogStatus(sid, row.phone) === 'escalated') {
      if (Number(row.defers) >= MAX_OPERATOR_DEFERS) {
        return finish('skipped', 'диалог на операторе дольше срока ожидания');
      }
      await deferRow(db, row, 'отложено: диалог на операторе', true);
      return;
    }
    if (await d.isMuted(row.rule_id, row.phone)) {
      return finish('cancelled', 'анти-повтор: напоминание уже отправлялось');
    }
    if (await d.sentTodayExists(sid, row.phone)) {
      await deferRow(db, row, 'анти-спам: сдвинуто на день');
      return;
    }

    // Темп отправки. Воркер арендует до 5 строк за тик и шлёт их за секунды —
    // для WhatsApp это пачка и риск блокировки инстанса. Место проверки
    // выбрано намеренно: ДО проверок YClients, бонусов и текста, потому что
    // откладывать надо до платного LLM-вызова и до НЕОБРАТИМОГО начисления.
    //
    // Fail-CLOSED, в отличие от большинства проверок воркера: недоступный
    // счётчик означал бы отправку пачкой, то есть ровно ту блокировку, от
    // которой пауза защищает. Минута ожидания стоит дёшево.
    //
    // Битое/отсутствующее значение интервала — тоже НЕ повод слать пачкой:
    // Number(null|'') дал бы 0, то есть молча выключил паузу в трёх строках
    // над объявленным fail-closed. Дефолт тот же, что в схеме и в
    // parseRuleBody (routes/reminders.js), плюс WARN — явный 0 остаётся
    // законным «без паузы».
    const intervalMin = resolveIntervalMin(row, d.log);
    if (intervalMin > 0) {
      let waitMs = 0;
      try {
        const lastAt = await d.lastPlannedSendAt(sid);
        waitMs = sendPacing.waitMsLeft(lastAt, intervalMin, Date.now());
      } catch (e) {
        d.log.warn(`row #${row.id}: счётчик темпа недоступен (${e.message}) — откладываю на ${intervalMin} мин`);
        waitMs = intervalMin * 60000;
      }
      if (waitMs > 0) {
        // Потолок по времени суток: без него пауза выносит хвост рассылки в
        // ночь живым пациентам (см. paceDeferMinutes).
        const minutes = sendPacing.paceDeferMinutes(Date.now(), waitMs, row.send_time);
        const capped = minutes > waitMs / 60000 + 1e-6;
        const reason = capped
          ? `темп: пауза ${intervalMin} мин упёрлась в ночь — перенесено на ${row.send_time}`
          : `темп: пауза ${intervalMin} мин между плановыми сообщениями`;
        await deferRowMinutes(db, row, minutes, reason);
        // Полноценного счётчика голодания нет (defers занят предельным
        // ожиданием оператора), поэтому каждое откладывание темпом видно
        // хотя бы строкой лога — иначе эффект наблюдается только по
        // перезаписанному decision_reason последней строки.
        d.log.info(`row #${row.id}: пауза темпа — откладываю на ${Math.ceil(minutes)} мин${capped ? ` (перенос на ${row.send_time})` : ''}`);
        // Явный признак для processTick: остальные строки ЭТОГО САЛОНА в этом
        // тике трогать нельзя — они упрутся в ту же паузу, а перезапись их
        // scheduled_at ломает порядок отправки (см. комментарий у processTick).
        return RESULT_PACED;
      }
    }

    // Проверки по живым записям YClients. Fail-open: перманентный сбой API не
    // должен молча остановить все напоминания (тот же размен, что в «Заботе»).
    const anchorMs = row.anchor_visit_at ? new Date(row.anchor_visit_at).getTime() : Date.now();
    let records = { completedAfter: [], future: [] };
    try { records = await d.loadClientRecords(sid, row.phone, anchorMs, Date.now()); }
    catch (e) { d.log.warn(`row #${row.id}: записи YClients недоступны (${e.message}) — без проверки записей`); }
    let catMap = await d.getCatMap(sid).catch(e => {
      d.log.warn(`row #${row.id}: карта категорий недоступна (${e.message})`);
      return new Map();
    });
    // hasFutureMatchingBooking глушит исключения по каждой записи и логгера у
    // него нет (он чистый) — систематически сломанная проверка (например,
    // catMap не Map) выглядит ровно как «совпадений нет», и клиента будут
    // дёргать напоминаниями, хотя он записан. Ловим здесь, где логгер есть.
    if (!(catMap instanceof Map)) {
      d.log.warn(`row #${row.id}: getCatMap вернул не Map (${typeof catMap}) — продолжаю с пустой картой`);
      catMap = new Map();
    }
    if (hasFutureMatchingBooking(records.future, row.rule_conditions, catMap)) {
      return finish('cancelled', 'клиент уже записан на аналогичную услугу');
    }
    if (hasFutureMatchingBooking(records.completedAfter, row.rule_conditions, catMap)) {
      return finish('cancelled', 'повторный визит уже состоялся');
    }

    // ── бонусы: строго один раз на строку ──────────────────────
    // Начисление НЕОБРАТИМО, поэтому повторная попытка (сбой отправки → откат
    // в scheduled) обязана взять уже записанный результат, а не начислить ещё раз.
    // Бонусы считаются ДО захвата строки — это БЕЗОПАСНЕЕ, а не просто
    // «раньше по коду»: крэш между начислением и отправкой оставляет строку
    // 'scheduled' с уже записанным bonus_accrued, следующая аренда его не
    // начислит повторно (ветка ниже), а сообщение всё-таки уйдёт. Обратный
    // порядок (бонусы после захвата) оставлял бы строку ложно 'sent' —
    // деньги начислены, сообщения нет, и строку больше никто не арендует.
    //
    // Бонусы считаются РАНЬШЕ решения Милы (buildText/decision) по ДРУГОЙ
    // причине: текст обязан содержать ФАКТИЧЕСКИ начисленную сумму, а не
    // прогноз. Следствие — если решение окажется 'escalate'/'stop_program'
    // (сообщение не уйдёт вовсе), деньги на карте клиента УЖЕ начислены
    // необратимо. Разворачивать порядок («сначала решение, потом начисление»)
    // не наша задача — это заметная переделка воркера, решение владельца
    // продукта; здесь только видимость такого исхода — WARN + decision_reason
    // у веток escalate/stop_program ниже.
    //
    // Окно двойного начисления: у ycAccrueCard (внутри applyBonus) НЕТ ключа
    // идемпотентности. Если applyBonus УЖЕ реально начислил деньги, а процесс
    // упал/оборвал соединение с БД ДО того, как результат записан в
    // bonus_accrued, при повторной аренде строка снова видна с
    // bonus_accrued IS NULL и снова вошла бы в эту ветку — деньги начислились
    // бы ВТОРОЙ раз, откатить нельзя. Поэтому строка сначала помечается
    // НАМЕРЕНИЕМ ('pending') ДО вызова applyBonus: если процесс упадёт после
    // начисления, но до записи результата, следующая аренда увидит
    // bonus_tier='pending' и НЕ будет начислять повторно (неизвестно, состоялось
    // ли оно) — пропущенное начисление дешевле двойного, та же философия
    // at-most-once доставки.
    let bonus;
    if (row.bonus_tier === 'pending') {
      // Прошлая попытка оборвалась ровно в этом окне — неизвестно, состоялось
      // ли начисление. Про сумму бонусов клиенту сообщать НЕЛЬЗЯ (могло не
      // случиться), уходит базовый текст без бонусной части; факт требует
      // ручной проверки карты клиента человеком — отсюда WARN.
      d.log.warn(`row #${row.id}: bonus_tier='pending' — прошлая попытка начисления оборвалась между YClients и записью результата; карту клиента нужно проверить вручную, сообщение уйдёт без бонусной части`);
      bonus = { balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null,
                note: 'бонус не подтверждён (pending) — сообщение без бонусной части, требуется ручная проверка карты клиента' };
    } else if (row.bonus_accrued != null || row.bonus_tier != null) {
      bonus = { balanceBefore: row.balance_before, tier: row.bonus_tier,
                accrued: row.bonus_accrued || 0, txnOk: row.bonus_txn_ok };
    } else if (row.bonus_enabled) {
      const claim = await db.query(
        `UPDATE reminder_queue SET bonus_tier='pending' WHERE id=$1 AND bonus_tier IS NULL`,
        [row.id]);
      if (!claim || !claim.rowCount) {
        // Заявку перехватили (параллельный процесс/повторная аренда той же
        // строки) — не начисляем в этом заходе, риск задвоения того не стоит.
        d.log.info(`row #${row.id}: заявку на бонус перехватили — не начисляем в этом заходе`);
        bonus = { balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null };
      } else {
        bonus = await d.applyBonus(sid, row.yclients_client_id, row.bonus_tiers, row.rule_title);
        await db.query(
          `UPDATE reminder_queue SET balance_before=$2, bonus_tier=$3, bonus_accrued=$4, bonus_txn_ok=$5
            WHERE id=$1`,
          [row.id, bonus.balanceBefore, bonus.tier, bonus.accrued, bonus.txnOk]);
      }
    } else {
      bonus = { balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null };
    }

    // Факт «деньги уже необратимо начислены, а решение может погасить
    // сообщение» — см. комментарий выше у объявления bonus.
    const bonusAccruedNote = (bonus.tier === 'accrue' && bonus.accrued > 0)
      ? `бонусы (${bonus.accrued}) уже начислены на карту клиента, но сообщение не отправлено`
      : null;

    // ── решение и текст ────────────────────────────────────────
    // buildText зовёт LLM в режиме free (до LLM_TIMEOUT_MS=60с) — строка
    // ЕЩЁ 'scheduled' в этот момент, захват — только ниже, вплотную перед
    // sendMessage (см. комментарий у капчура).
    const decision = await buildText(row, bonus, d);

    if (decision.action === 'escalate') {
      // Осложнение в переписке (промпт care-прохода): касание НЕ отправляем,
      // к пациенту как можно скорее подключается человек. Порядок
      // сознательный: если escalateDialog упадёт, decision.reason ещё не
      // записан в БД — общий catch вернёт строку на ретрай, и эскалация
      // будет повторена, а не потеряна с уже-skipped строкой.
      const why = decision.reason || 'осложнение в переписке';
      // bonusAccruedNote: деньги уже могли уйти на карту клиента ДО этого
      // решения (бонусы считаются раньше decision, см. комментарий выше) —
      // сообщение не уйдёт, и это нельзя пропустить: WARN + decision_reason.
      if (bonusAccruedNote) d.log.warn(`row #${row.id}: эскалация после начисления бонусов — ${bonusAccruedNote}`);
      await d.escalateDialog(sid, row.phone, why);
      return finish('skipped', bonusAccruedNote
        ? `Мила: эскалация — ${why}; ${bonusAccruedNote}`
        : `Мила: эскалация — ${why}`);
    }
    if (decision.action === 'stop_program') {
      // Просьба «не пишите мне»: source='manual' — в отличие от штатного
      // мьюта после отправки (source='auto'), этот НЕ снимается автоматически
      // при следующем визите (enroll.js фильтрует по source='auto').
      const why = decision.reason || 'клиент попросил не писать';
      if (bonusAccruedNote) d.log.warn(`row #${row.id}: stop_program после начисления бонусов — ${bonusAccruedNote}`);
      await d.mute(sid, row.rule_id, row.phone, why, 'manual');
      return finish('cancelled', bonusAccruedNote
        ? `Мила: ${why}; ${bonusAccruedNote}`
        : `Мила: ${why}`);
    }

    // decision.reason — единственное объяснение немедленного решения Милы
    // (в т.ч. fail-safe skip из parseCareDecision) — обязано попасть в
    // decision_reason строки, а не тонуть в общей формулировке. Пустой текст
    // без причины (strict-режим на пустом шаблоне) — прежняя формулировка.
    const text = decision.action === 'send' ? decision.text : null;
    if (!text || !String(text).trim()) {
      return finish('skipped', decision.reason ? `Мила: ${decision.reason}` : 'текст напоминания пуст');
    }
    const viol = d.hardViolations(d.lintReply(text, {}));
    if (viol.length) return finish('skipped', `reply-guard: ${viol.map(v => v.type).join(',')}`);

    const last = await d.lastIncomingChannel(sid, row.phone).catch(() => null);
    const routing = notifications.resolveRouting([], true, last);

    // ── захват строки: с этого момента она наша ────────────────
    // ПОСЛЕДНИЙ гейт перед side-effect'ами — вплотную перед sendMessage, а не
    // до бонусов/buildText (как было раньше). Тот же приём, что в
    // care-воркере (услуга-донор паттерна): падение процесса (OOM,
    // pm2 restart) между старым ранним захватом и реальной отправкой
    // оставляло строку 'sent' без rendered_text/delivery_id и БЕЗ отправки —
    // LEASE_SQL арендует только 'scheduled', и такая строка терялась бы
    // навсегда, выглядя в дашборде отправленной.
    const marked = await db.query(
      `UPDATE reminder_queue
          SET status='sent', sent_at=NOW(), error=NULL, rendered_text=$2, routing=$3::jsonb
        WHERE id=$1 AND status='scheduled'`,
      [row.id, text, JSON.stringify(routing)]);
    if (!marked || !marked.rowCount) {
      d.log.info(`row #${row.id}: строка перехвачена другим исходом — не отправляем`);
      return;
    }

    // ── отправка ───────────────────────────────────────────────
    const delivery = await d.sendMessage({ text, phone: row.phone, dispatchRouting: routing });
    delivered = true;
    d.log.info(`delivered #${row.id} delivery=${delivery && delivery.id}`);

    const channelUsed = (delivery && (delivery.channel || delivery.messenger)) || routing[0] || null;
    await db.query(
      `UPDATE reminder_queue SET delivery_id=$2, channel_used=$3, decision_reason=$4 WHERE id=$1`,
      // bonus.note объясняет администратору, почему бонусная часть именно
      // такая: 'pending' (см. выше) — почему её нет вовсе, сухой прогон
      // тестовой отправки — почему сумма показана, но деньги не ушли.
      [row.id, delivery && delivery.id != null ? String(delivery.id) : null, channelUsed,
       bonus.note || `отправлено, ступень ${bonus.tier}`]
    ).catch(e => d.log.error(`persist delivery #${row.id}: ${e.message}`));

    // Флаг анти-повтора вешается ТОЛЬКО за фактически отправленное сообщение.
    await d.mute(sid, row.rule_id, row.phone, 'напоминание отправлено')
      .catch(e => d.log.error(`mute #${row.id}: ${e.message}`));

    await d.rememberPending(sid, row.phone, text);
    if (channelUsed === 'whatsapp') {
      await d.persistWhatsapp(sid, { delivery, phone: row.phone, text })
        .catch(e => d.log.error(`persist wa: ${e.message}`));
    }
  } catch (e) {
    if (delivered) {
      // Доставлено клиенту — статус НЕ откатывать НИКОГДА: ретрай = дубль.
      d.log.error(`row #${row.id}: доставлено, но пост-обработка упала: ${e.message}`);
      await d.db.query(`UPDATE reminder_queue SET status='sent', error=$2 WHERE id=$1`,
        [row.id, String(e.message || e).slice(0, 500)]).catch(() => {});
      return;
    }
    if (terminal) {
      d.log.error(`row #${row.id}: терминальный статус записан, хвост упал: ${e.message}`);
      return;
    }
    // Отправки не было. Возврат в scheduled безопасен: бонусы уже записаны в
    // строку и повторно не начислятся.
    const final = row.attempts >= MAX_ATTEMPTS;
    await d.db.query(
      `UPDATE reminder_queue SET status='${final ? 'failed' : 'scheduled'}', sent_at=NULL, error=$2 WHERE id=$1`,
      [row.id, String(e.message || e).slice(0, 500)]).catch(() => {});
    d.log.warn(`row #${row.id} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${e.message}`);
  }
}

// Аренда. КРИТИЧНО: на алиас цели UPDATE (rq) нельзя ссылаться из ON-условий
// джойнов во FROM — PG отвечает «invalid reference to FROM-clause entry».
// Поэтому имя клиента берётся скалярным подзапросом в RETURNING (там ссылка
// на rq легальна). Юнит-моки db.any валидность SQL не проверяют — после правок
// обязателен живой EXPLAIN на дев-БД, SQL экспортируется именно для этого.
//
// Вариантов аренды два, и набор колонок RETURNING у них ОБЯЗАН быть общим —
// отсюда сборка из одного шаблона, а не вторая копия SQL: processOne читает
// rule_text/text_mode/bonus_tiers/client_name, и разъехавшиеся копии означали
// бы, что тестовая отправка гоняет строку с другим набором полей, чем боевая.
//   single=false — боевой тик: до 5 просроченных строк с backoff по попыткам;
//   single=true  — адресная аренда ОДНОЙ строки по id, БЕЗ условия
//                  «scheduled_at <= NOW()»: тестовая строка намеренно стоит в
//                  будущем, чтобы её не перехватил боевой тик (test-send.js).
function buildLeaseSql({ single }) {
  const pick = single
    ? `SELECT id FROM reminder_queue
         WHERE id = $1 AND status = 'scheduled'
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
    // Тай-брейк id ASC обязателен: planBackfillSchedule ставит всем строкам
    // одного дня ОДИН И ТОТ ЖЕ scheduled_at, и решение владельца салона
    // «первым получает тот, кто не был дольше всех» держалось лишь на порядке
    // вставки (догон вставляет строки в нужной очерёдности). С паузой темпа
    // этот порядок стал ВИДИМЫМ: он решает, кто получит сообщение в 11:00, а
    // кто вечером.
    //
    // Порядок держится только потому, что пауза темпа НЕ переписывает
    // scheduled_at всей пачке: строку двигает лишь ПЕРВОЕ срабатывание паузы в
    // тике, остальные строки салона processTick пропускает нетронутыми. Пока
    // деферилась каждая арендованная строка, ключ сортировки менялся у 4 строк
    // из 5 за тик, и следующая пачка (более СВЕЖИЕ визиты, ещё стоящие на
    // исходном scheduled_at) обгоняла их — второе сообщение уходило примерно
    // 21-й строке вместо второй. Тай-брейк id ASC при этом не спасал: он
    // работает лишь ВНУТРИ одного scheduled_at.
    //
    // Остаточный эффект: сама отложенная строка всё-таки уезжает за хвост
    // нетронутых (её scheduled_at теперь позже), то есть уходит в конец
    // рассылки. Это одна строка на срабатывание паузы, а не вся пачка;
    // убрать её совсем нельзя — иначе аренда возвращала бы ту же строку
    // каждый тик до конца паузы.
    : `SELECT id FROM reminder_queue
         WHERE status = 'scheduled' AND scheduled_at <= NOW()
           AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
         ORDER BY scheduled_at ASC, id ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED`;
  return `UPDATE reminder_queue rq
      SET attempts = rq.attempts + 1, last_attempt_at = NOW()
     FROM reminder_rules r
     JOIN salons sal ON sal.id = r.salon_id
    WHERE r.id = rq.rule_id
      AND rq.id IN (
        ${pick})
    RETURNING rq.*, r.is_enabled AS rule_enabled, r.conditions AS rule_conditions,
              r.text AS rule_text, r.text_mode, r.bonus_enabled, r.bonus_tiers,
              r.delay_days, r.attribution_days, r.send_interval_min, r.send_time,
              sal.name AS salon_name,
              (SELECT cl.name FROM clients cl WHERE cl.id = rq.client_id) AS client_name`;
}

const LEASE_SQL = buildLeaseSql({ single: false });
const LEASE_ONE_SQL = buildLeaseSql({ single: true });

// Строки удалённых правил join не вернёт — они висели бы scheduled вечно.
const ORPHAN_SQL =
  `UPDATE reminder_queue SET status='cancelled', decision_reason='правило удалено'
    WHERE status='scheduled' AND rule_id IS NULL`;

let _tickInFlight = false;

/**
 * Один тик воркера: аренда до 5 due-строк и последовательная обработка.
 *
 * Пауза темпа — гейт уровня САЛОНА, а не строки: если она сработала на первой
 * же строке салона, все остальные строки ЭТОГО салона в этом тике упрутся в ту
 * же паузу (счётчик один на салон и обновляется только успешной отправкой).
 * Поэтому они просто ПРОПУСКАЮТСЯ — строка остаётся ровно там, где стояла
 * (единственный запрос по ним за тик — общая компенсация attempts в самом
 * конце, см. ниже; ни scheduled_at, ни decision_reason он не трогает):
 *
 *  - deferRowMinutes переписывает scheduled_at на NOW()+N, а аренда сортирует
 *    ПО scheduled_at первым ключом — отложенная строка уходила в хвост за ещё
 *    не тронутые строки той же пачки, то есть за БОЛЕЕ СВЕЖИЕ визиты. Решение
 *    владельца салона «первым получает тот, кто не был дольше всех» переставало
 *    соблюдаться ровно тогда, когда пачка не влезает в дневную ёмкость (при
 *    паузе 30 мин шаг доходил до ~150 строк);
 *  - заодно исчезли холостые UPDATE: 4 из 5 арендованных строк каждую минуту
 *    тратились на цикл «SELECT счётчика + UPDATE» с перезаписью decision_reason
 *    у сотен строк подряд.
 *
 * Множество живёт РОВНО один тик (локальная переменная, не модульная): пауза
 * измеряется минутами, между тиками её надо считать заново. Гейт именно ПО
 * САЛОНУ — строки других салонов в том же тике обрабатываются как обычно, у них
 * свой счётчик темпа.
 */
async function processTick(deps = defaultDeps) {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    const d = { ...defaultDeps, ...deps };
    await d.db.query(ORPHAN_SQL).catch(e => d.log.error(`orphan cleanup: ${e.message}`));
    const rows = await d.db.any(LEASE_SQL, [RETRY_BACKOFF_S]);
    const pacedSalons = new Set();
    const skippedIds = [];
    for (const row of rows) {
      if (pacedSalons.has(row.salon_id)) { skippedIds.push(row.id); continue; }
      const res = await processOne(row, d);
      if (res && res.pacePaused) pacedSalons.add(row.salon_id);
    }
    if (skippedIds.length) {
      // Одной строкой на тик, а не по строке: пропуск — это штатный ход
      // рассылки, а не событие, но совсем без следа тик выглядел бы «ничего не
      // делал».
      d.log.info(`пауза темпа: пропущено без изменений ${skippedIds.length} строк(и) салонов [${[...pacedSalons].join(',')}]`);
      // Компенсация инкремента аренды. LEASE_SQL добавляет attempts+1 КАЖДОЙ
      // выданной строке, а пропуск по паузе — НЕ попытка отправки: воркер этих
      // строк даже не касался. Без отката после большого догона attempts у них
      // вырастает до десятков (строка переарендуется каждые RETRY_BACKOFF_S),
      // и первый же транзиентный сбой отправки уводит её сразу в 'failed'
      // (final = row.attempts >= MAX_ATTEMPTS) вместо трёх законных попыток —
      // пациент молча остаётся без напоминания, а в дашборде это выглядит как
      // исчерпанные попытки, которых не было. Ровно −1, а не обнуление: это
      // компенсация ОДНОГО инкремента, и двойного отката быть не может —
      // каждая аренда приносит свой собственный +1.
      //
      // ОДИН запрос на весь тик (не построчно) и НИ ОДНОГО другого поля:
      // scheduled_at, last_attempt_at и decision_reason обязаны остаться как
      // есть — в этом весь смысл пропуска (строка не должна сдвинуться в
      // очереди). last_attempt_at при этом намеренно не чистится: он держит
      // backoff аренды и не даёт тику молотить ту же пятёрку каждую минуту.
      await d.db.query(
        `UPDATE reminder_queue SET attempts = GREATEST(attempts - 1, 0) WHERE id = ANY($1)`,
        [skippedIds])
        .catch(e => d.log.warn(`компенсация attempts у пропущенных строк не удалась (${e.message}) — у ${skippedIds.length} строк(и) бюджет попыток остался урезанным на 1 незаслуженно`));
    }
  } finally {
    _tickInFlight = false;
  }
}

// ── тестовая отправка на свой номер ────────────────────────────
// Прогон идёт ТЕМ ЖЕ processOne, что и боевой: иначе тест не доказывал бы
// ничего о боевом пути. Отличий ровно пять, и каждое — про то, что тест не
// должен портить боевое состояние клиента и не должен молча не состояться:
//   1) анти-повтор не ставится и прошлый не мешает (тест повторяем);
//   2) дневной лимит «1 плановое сообщение в день» не применяется;
//   3) живые записи клиента (он уже записан / уже пришёл) тест не отменяют —
//      ради текста и ступени тест и запускается;
//   4) бонусы по умолчанию считаются сухим прогоном (начисление необратимо);
//   5) пауза темпа между сообщениями не применяется (тест — одно сообщение).
// Гейт Милы (ЧС/режим/тумблер), выключенное правило и пауза оператора
// остаются в силе: это «этому номеру сейчас нельзя», и тест не повод.
function buildTestDeps(base, { accrue = false } = {}) {
  const d = { ...defaultDeps, ...base };
  return {
    ...d,
    isMuted: async () => false,
    mute: async () => {},
    sentTodayExists: async () => false,
    loadClientRecords: async () => ({ completedAfter: [], future: [] }),
    // Записи пустые — карта категорий нужна только им, лишний запрос в
    // YClients за ней делать незачем.
    getCatMap: async () => new Map(),
    // 5-е отличие тестовой отправки: паузу темпа тест не ждёт. Она защищает
    // живую рассылку от блокировки мессенджера, а тест — это ОДНО сообщение
    // на свой номер; отложенная тестовая строка через час была бы погашена
    // в cancelled (processTestRow), и администратор не увидел бы ничего.
    lastPlannedSendAt: async () => null,
    applyBonus: accrue ? d.applyBonus : d.applyBonusDry,
  };
}

/**
 * Арендовать ОДНУ строку по id и прогнать её тестовыми deps.
 * @returns {Promise<number|null>} id обработанной строки или null, если её уже
 *   не было в состоянии 'scheduled' (перехватили/отменили).
 */
async function processTestRow(rowId, opts = {}, deps = {}) {
  const d = buildTestDeps(deps, opts);
  const rows = await d.db.any(LEASE_ONE_SQL, [rowId]);
  if (!rows.length) return null;
  // Проверяют обычно ещё ВЫКЛЮЧЕННОЕ правило — ради этого тест и нужен. Гейт
  // rule_enabled защищает очередь от строк отключённого правила, а здесь
  // администратор нажал «тест» на этом самом правиле явно.
  const row = { ...rows[0], rule_enabled: true };
  try {
    await processOne(row, d);
  } finally {
    // Строка, оставшаяся 'scheduled' (гейт отложил её), стоит в БУДУЩЕМ — через
    // час её арендовал бы боевой тик и отправил бы тестовое сообщение
    // по-настоящему, уже с боевыми deps (реальное начисление, реальный
    // анти-повтор). Гасим сразу; у отправленной/терминальной строки условие
    // status='scheduled' не сработает.
    await d.db.query(
      `UPDATE reminder_queue
          SET status='cancelled',
              decision_reason = COALESCE(decision_reason, 'тестовая отправка не состоялась')
        WHERE id=$1 AND status='scheduled'`, [rowId])
      .catch(e => d.log.error(`test row #${rowId} cleanup: ${e.message}`));
  }
  return rows[0].id;
}

let _running = false;
function startRemindersWorker() {
  if (_running) return;
  _running = true;
  if (!config.CHATPUSH.instanceToken) {
    log.warn('CHATPUSH_INSTANCE_TOKEN is not set — reminders worker disabled');
    return;
  }
  setInterval(() => { processTick().catch(e => log.error(`tick: ${e.message}`)); }, WORKER_TICK_MS);
  log.info(`Reminders worker started (tick=${WORKER_TICK_MS}ms)`);
}

module.exports = {
  processOne, processTick, startRemindersWorker, defaultDeps,
  processTestRow, buildTestDeps, loadBonusSalon,
  LEASE_SQL, LEASE_ONE_SQL, ORPHAN_SQL, MAX_OPERATOR_DEFERS,
  // Признак исхода «сработала пауза темпа» — контракт processOne ↔ processTick.
  RESULT_PACED,
};
