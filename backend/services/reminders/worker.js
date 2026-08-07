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
const chatEvents = require('../chat-events');
const careContext = require('../care/context');
const { plusOneDay } = require('../care/schedule');
const { hasFutureMatchingBooking } = require('./eligibility');
const { renderReminderText, pickTierText } = require('./template');
const { pickTier } = require('./tiers');
const bonusSvc = require('./bonus');
const { buildCarePrompt } = require('../care/care-prompt');
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
    const salon = await realDb.one(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token,
              yclients_card_type_id
         FROM salons WHERE id=$1`, [salonId]);
    return bonusSvc.applyBonus(salon, ycClientId, tiers, ruleTitle);
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
 * Решение по напоминанию: strict — всегда {action:'send', text, reason:null}
 * (шаблон детерминирован). free — Мила решает по заготовке смысла тем же
 * care-промптом, и решение может быть 'send'/'skip'/'escalate'/'stop_program'
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

  // free: заготовка смысла (уже с подставленными цифрами) уходит в тот же
  // care-промпт — отдельного промпта для напоминаний не заводим.
  const transcript = await deps.loadTranscript(row.salon_id, row.phone, { limit: 15 })
    .catch(() => ({ messages: [] }));
  const { system, user } = buildCarePrompt({
    salonName: row.salon_name,
    clientName: row.client_name,
    nameDictionary: tplCtx.nameDictionary,
    touch: { title: row.rule_title, intent_text: renderReminderText(raw, tplCtx), text_mode: 'free' },
    enrollment: { staff_name: row.anchor_staff_name, visit_at: row.anchor_visit_at, services },
    transcript: (transcript.messages || []).map(m => ({
      direction: m.role === 'user' ? 'incoming' : 'outgoing',
      // stripOperatorMark — care-промпт про пометку администратора не знает и
      // отдал бы её клиенту дословно в тексте (тот же дефект чинили в «Заботе»).
      text: stripOperatorMark(typeof m.content === 'string' ? m.content
        : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join(' ') : '')),
    })).filter(m => m.text),
    futureBookings: [],
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
    let bonus;
    if (row.bonus_accrued != null || row.bonus_tier != null) {
      bonus = { balanceBefore: row.balance_before, tier: row.bonus_tier,
                accrued: row.bonus_accrued || 0, txnOk: row.bonus_txn_ok };
    } else if (row.bonus_enabled) {
      bonus = await d.applyBonus(sid, row.yclients_client_id, row.bonus_tiers, row.rule_title);
      await db.query(
        `UPDATE reminder_queue SET balance_before=$2, bonus_tier=$3, bonus_accrued=$4, bonus_txn_ok=$5
          WHERE id=$1`,
        [row.id, bonus.balanceBefore, bonus.tier, bonus.accrued, bonus.txnOk]);
    } else {
      bonus = { balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null };
    }

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
      await d.escalateDialog(sid, row.phone, why);
      return finish('skipped', `Мила: эскалация — ${why}`);
    }
    if (decision.action === 'stop_program') {
      // Просьба «не пишите мне»: source='manual' — в отличие от штатного
      // мьюта после отправки (source='auto'), этот НЕ снимается автоматически
      // при следующем визите (enroll.js фильтрует по source='auto').
      const why = decision.reason || 'клиент попросил не писать';
      await d.mute(sid, row.rule_id, row.phone, why, 'manual');
      return finish('cancelled', `Мила: ${why}`);
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
      [row.id, delivery && delivery.id != null ? String(delivery.id) : null, channelUsed,
       `отправлено, ступень ${bonus.tier}`]
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
const LEASE_SQL =
  `UPDATE reminder_queue rq
      SET attempts = rq.attempts + 1, last_attempt_at = NOW()
     FROM reminder_rules r
     JOIN salons sal ON sal.id = r.salon_id
    WHERE r.id = rq.rule_id
      AND rq.id IN (
        SELECT id FROM reminder_queue
         WHERE status = 'scheduled' AND scheduled_at <= NOW()
           AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
         ORDER BY scheduled_at ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED)
    RETURNING rq.*, r.is_enabled AS rule_enabled, r.conditions AS rule_conditions,
              r.text AS rule_text, r.text_mode, r.bonus_enabled, r.bonus_tiers,
              r.delay_days, r.attribution_days, sal.name AS salon_name,
              (SELECT cl.name FROM clients cl WHERE cl.id = rq.client_id) AS client_name`;

// Строки удалённых правил join не вернёт — они висели бы scheduled вечно.
const ORPHAN_SQL =
  `UPDATE reminder_queue SET status='cancelled', decision_reason='правило удалено'
    WHERE status='scheduled' AND rule_id IS NULL`;

let _tickInFlight = false;

async function processTick(deps = defaultDeps) {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    const d = { ...defaultDeps, ...deps };
    await d.db.query(ORPHAN_SQL).catch(e => d.log.error(`orphan cleanup: ${e.message}`));
    const rows = await d.db.any(LEASE_SQL, [RETRY_BACKOFF_S]);
    for (const row of rows) await processOne(row, d);
  } finally {
    _tickInFlight = false;
  }
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
  LEASE_SQL, ORPHAN_SQL, MAX_OPERATOR_DEFERS,
};
