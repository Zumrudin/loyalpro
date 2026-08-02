'use strict';
// Воркер «Отдела заботы». Аренда due-строк как в notification-воркере
// (FOR UPDATE SKIP LOCKED + attempts при аренде), затем на каждую строку:
// детерминированные проверки → care-проход LLM → отправка → персист.
// Все внешние зависимости инжектируются (юнит-тесты без БД/сети).
//
// Ответы пациента на касание обрабатывает ОСНОВНОЙ агент Милы (обычный
// вебхук-путь со всеми мед-границами) — воркер в это не вмешивается;
// rememberPending лишь подмешивает отправленное касание в транскрипт
// основного агента до прихода эха Chatpush.

const config = require('../../config');
const { db: realDb } = require('../../db');
const chatpush = require('../chatpush');
const agentSettings = require('../agent-settings');
const { getProvider } = require('../agent/providers');
const history = require('../agent/history');
const pendingReplies = require('../agent/pending-replies');
const replyGuard = require('../agent/reply-guard');
const notifications = require('../notifications');
const chatEvents = require('../chat-events');
const context = require('./context');
const { buildCarePrompt } = require('./care-prompt');
const { parseCareDecision } = require('./decision');
const { plusOneDay } = require('./schedule');
const { createLogger } = require('../../logger');

const log = createLogger('CareWorker');

const WORKER_TICK_MS  = 15000;
const MAX_ATTEMPTS    = 3;
const RETRY_BACKOFF_S = 120;

const defaultDeps = {
  db: realDb,
  isAllowed: (salonId, phone) => agentSettings.isAllowed(salonId, phone),
  agentGloballyEnabled: () => !!config.CHATPUSH.agentEnabled,
  dialogStatus: async (salonId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT status FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`,
      [salonId, phone]);
    return r ? r.status : null;
  },
  sentTodayExists: async (salonId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT 1 FROM care_touch_sends s
         JOIN care_enrollments e ON e.id = s.enrollment_id
        WHERE e.salon_id = $1 AND e.phone = $2 AND s.status = 'sent'
          AND (s.sent_at AT TIME ZONE 'Europe/Moscow')::date
              = (NOW() AT TIME ZONE 'Europe/Moscow')::date
        LIMIT 1`,
      [salonId, phone]);
    return !!r;
  },
  loadClientRecords: context.loadClientRecords,
  getCatMap: async (salonId) => {
    const salon = await realDb.one(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
         FROM salons WHERE id=$1`, [salonId]);
    return notifications.getServiceCategoryMap(salon);
  },
  loadTranscript: (salonId, key, opts) => history.loadTranscript(salonId, key, opts),
  createMessage: (req, opts) => getProvider().createMessage(req, opts),
  lintReply: replyGuard.lintReply,
  hardViolations: replyGuard.hardViolations,
  sendMessage: (payload) => chatpush.sendMessage(config.CHATPUSH.instanceToken, payload),
  lastIncomingChannel: notifications.lastIncomingChannel,
  rememberPending: (salonId, key, text) => pendingReplies.remember(salonId, key, text),
  // Тот же механизм, что services/agent/tools/escalate-to-operator.js:
  // status='escalated' + emitAgentStatus (красный чат сверху списка немедленно).
  // Upsert, а не UPDATE: клиент мог никогда не писать агенту — строки
  // agent_dialogs у него ещё нет, а оператора позвать всё равно надо.
  escalateDialog: async (salonId, phone, reason) => {
    await realDb.query(
      `INSERT INTO agent_dialogs (salon_id, dialog_key, status, escalated_reason)
       VALUES ($1,$2,'escalated',$3)
       ON CONFLICT (salon_id, dialog_key) DO UPDATE
         SET status='escalated', escalated_reason=$3, updated_at=now()`,
      [salonId, phone, reason]);
    await realDb.query(
      `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload)
       VALUES ($1,$2,'escalated','care_worker',$3)`,
      [salonId, phone, JSON.stringify({ reason })]);
    chatEvents.emitAgentStatus(salonId, phone, 'escalated', reason);
  },
  persistWhatsapp: async () => {},   // подключается в Task 10
  log,
};

// Статусы вшиваются в SQL литералами (а не $-параметрами) сознательно:
// значения приходят ТОЛЬКО из этих двух Set'ов (никогда от клиента), а
// журнал/тесты/grep по логам ищут статус прямо в тексте запроса.
const SEND_STATUSES = new Set(['scheduled', 'sent', 'skipped', 'cancelled', 'failed']);
const ENROLLMENT_STATUSES = new Set(['active', 'completed', 'declined', 'escalated', 'superseded', 'stopped']);

async function markSend(db, id, status, reason) {
  if (!SEND_STATUSES.has(status)) throw new Error(`bad send status: ${status}`);
  await db.query(
    `UPDATE care_touch_sends SET status='${status}', decision_reason=$2 WHERE id=$1`,
    [id, reason || null]);
}

async function stopEnrollment(db, enrollmentId, status, reason) {
  if (!ENROLLMENT_STATUSES.has(status)) throw new Error(`bad enrollment status: ${status}`);
  await db.query(
    `UPDATE care_enrollments SET status='${status}', status_reason=$2, updated_at=NOW()
      WHERE id=$1 AND status='active'`,
    [enrollmentId, reason || null]);
  await db.query(
    `UPDATE care_touch_sends SET status='cancelled', decision_reason=$2
      WHERE enrollment_id=$1 AND status='scheduled'`,
    [enrollmentId, `enrollment ${status}: ${reason || ''}`.slice(0, 500)]);
}

/** Цепочка пройдена (нет больше scheduled) → enrollment completed. */
async function maybeCompleteChain(db, enrollmentId) {
  const left = await db.oneOrNone(
    `SELECT 1 FROM care_touch_sends WHERE enrollment_id=$1 AND status='scheduled' LIMIT 1`,
    [enrollmentId]);
  if (!left) {
    await db.query(
      `UPDATE care_enrollments SET status='completed', status_reason='цепочка пройдена',
              updated_at=NOW()
        WHERE id=$1 AND status='active'`, [enrollmentId]);
  }
}

async function processOne(row, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const { db } = d;
  const sid = row.salon_id;

  try {
    // ── детерминированные проверки ─────────────────────────────
    if (row.enrollment_status !== 'active') {
      return markSend(db, row.id, 'cancelled', `enrollment ${row.enrollment_status}`);
    }
    if (!row.program_enabled) return markSend(db, row.id, 'skipped', 'программа выключена');
    if (!d.agentGloballyEnabled()) return markSend(db, row.id, 'skipped', 'агент выключен (env)');

    const gate = await d.isAllowed(sid, row.phone);   // fail-closed: throw → catch ниже
    if (!gate.allow) return markSend(db, row.id, 'skipped', `гейт Милы: ${gate.reason}`);

    const dlg = await d.dialogStatus(sid, row.phone);
    if (dlg === 'escalated') return markSend(db, row.id, 'skipped', 'диалог на операторе');

    if (await d.sentTodayExists(sid, row.phone)) {
      // Анти-спам «1 касание в день»: сдвигаем на завтра, бюджет попыток обнуляем.
      await db.query(
        `UPDATE care_touch_sends SET scheduled_at=$2, attempts=0, last_attempt_at=NULL,
                decision_reason='анти-спам: сдвинуто на день'
          WHERE id=$1`,
        [row.id, plusOneDay(new Date(row.scheduled_at || Date.now()))]);
      return;
    }

    // Повторный визит по условиям программы после якоря → цель достигнута.
    //
    // РЕШЕНИЕ «YClients недоступен → fail-open» (обоснование, ревизия
    // код-ревью 2026-08-02): loadClientRecords THROWS при живом сбое
    // (см. контракт в context.js). Ловим здесь и продолжаем БЕЗ
    // retention-проверки (records остаётся пустым), а не блокируем отправку
    // касания — перманентный сбой YClients (аналог инцидента 2026-08-02 с
    // архивацией категорий каталога при устойчивых 429) не должен молча
    // остановить все care-касания навсегда. Цена fail-open — одно лишнее
    // касание в редком совпадении «сбой YClients именно на этой строке» +
    // «клиент как раз был на повторном визите»: воркер зайдёт снова на
    // следующем тике и остановит цепочку с опозданием, а не потеряет её.
    const anchorMs = row.visit_at ? new Date(row.visit_at).getTime() : Date.now();
    let records = { completedAfter: [], future: [] };
    try { records = await d.loadClientRecords(sid, row.phone, anchorMs, Date.now()); }
    catch (e) { d.log.warn(`send #${row.id}: записи YClients недоступны (${e.message}) — контекст без них`); }
    // catMap — та же fail-open логика: пустая карта молча не матчит условия
    // ПО КАТЕГОРИИ (условия по staff/service всё равно сработают) — но это
    // надо видеть в логах, иначе разбор инцидента «программа не завершилась
    // по категории» упрётся в «неизвестно, что вернул getCatMap».
    const catMap = await d.getCatMap(sid).catch(e => {
      d.log.warn(`send #${row.id}: карта категорий недоступна (${e.message}) — условия по категории не сматчатся`);
      return new Map();
    });
    if (context.hasMatchingRepeatVisit(records.completedAfter, row.program_conditions, catMap)) {
      await stopEnrollment(db, row.enrollment_id, 'completed', 'клиент уже был на повторном визите');
      return markSend(db, row.id, 'cancelled', 'повторный визит состоялся');
    }

    // ── care-проход LLM ────────────────────────────────────────
    const transcript = await d.loadTranscript(sid, row.phone, { limit: 15 })
      .catch(() => ({ messages: [] }));
    const trList = (transcript.messages || []).map(m => ({
      direction: m.role === 'user' ? 'incoming' : 'outgoing',
      text: typeof m.content === 'string' ? m.content
        : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join(' ') : ''),
    })).filter(m => m.text);
    const futureBookings = records.future.map(r => ({
      datetime: r.datetime || r.date || '',
      services: (Array.isArray(r.services) ? r.services : []).map(s => s.title).filter(Boolean),
      staff_name: (r.staff && r.staff.name) || null,
    }));
    const { system, user } = buildCarePrompt({
      salonName: row.salon_name, clientName: row.client_name,
      touch: { title: row.touch_title, intent_text: row.intent_text },
      enrollment: { staff_name: row.staff_name, visit_at: row.visit_at, services: row.visit_services },
      transcript: trList, futureBookings,
    });
    const resp = await d.createMessage(
      { system, messages: [{ role: 'user', content: user }] },
      { maxTokens: 700 });
    const decision = parseCareDecision(resp && resp.text);

    if (decision.action === 'escalate') {
      // Осложнение в переписке: касание НЕ отправляем, к пациенту как можно
      // скорее подключается человек. Порядок сознательный: сначала перевод
      // диалога на оператора — если он упадёт, общий catch вернёт строку на
      // ретрай и эскалация будет повторена (а не потеряна с уже-skipped строкой).
      const why = decision.reason || 'осложнение в переписке';
      await d.escalateDialog(sid, row.phone, why);
      await stopEnrollment(db, row.enrollment_id, 'escalated', why);
      return markSend(db, row.id, 'skipped', `Мила: эскалация — ${why}`);
    }
    if (decision.action === 'stop_program') {
      await stopEnrollment(db, row.enrollment_id, decision.status, decision.reason);
      return markSend(db, row.id, 'cancelled', `Мила: ${decision.reason}`);
    }
    if (decision.action === 'skip') {
      await markSend(db, row.id, 'skipped', `Мила: ${decision.reason}`);
      return maybeCompleteChain(db, row.enrollment_id);
    }

    // ── отправка ───────────────────────────────────────────────
    const viol = d.hardViolations(d.lintReply(decision.text, {}));
    if (viol.length) {
      await markSend(db, row.id, 'skipped',
        `reply-guard: ${viol.map(v => v.type).join(',')}`);
      return maybeCompleteChain(db, row.enrollment_id);
    }
    const last = await d.lastIncomingChannel(sid, row.phone).catch(() => null);
    const routing = notifications.resolveRouting([], true, last);   // дефолт telegram→whatsapp
    const delivery = await d.sendMessage({ text: decision.text, phone: row.phone, dispatchRouting: routing });
    const channelUsed = (delivery && (delivery.channel || delivery.messenger)) || routing[0] || null;

    await db.query(
      `UPDATE care_touch_sends
          SET status='sent', sent_at=NOW(), error=NULL, decision_reason=$2,
              rendered_text=$3, routing=$4::jsonb, delivery_id=$5, channel_used=$6
        WHERE id=$1`,
      [row.id, `Мила: ${decision.reason}`, decision.text, JSON.stringify(routing),
       delivery && delivery.id != null ? String(delivery.id) : null, channelUsed]);

    // Транскрипт/чат: pending до прихода эха; whatsapp эха не шлёт — персист сразу.
    d.rememberPending(sid, row.phone, decision.text);
    if (channelUsed === 'whatsapp') {
      await d.persistWhatsapp(sid, { delivery, phone: row.phone, text: decision.text })
        .catch(e => d.log.error(`persist wa: ${e.message}`));
    }
    d.log.info(`sent #${row.id} enrollment=${row.enrollment_id} routing=[${routing.join(',')}]`);
    await maybeCompleteChain(db, row.enrollment_id);
  } catch (e) {
    const final = row.attempts >= MAX_ATTEMPTS;
    await d.db.query(
      `UPDATE care_touch_sends SET status='${final ? 'failed' : 'scheduled'}', error=$2 WHERE id=$1`,
      [row.id, String(e.message || e).slice(0, 500)]
    ).catch(() => {});
    d.log.warn(`send #${row.id} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${e.message}`);
  }
}

// Аренда due-строк. КРИТИЧНО (спек-ревью 2026-08-02): на алиас цели UPDATE
// (cts) НЕЛЬЗЯ ссылаться из ON-условий джойнов во FROM — PG отвечает
// «invalid reference to FROM-clause entry for table "cts"», и воркер падал бы
// каждый тик (юнит-тесты с замоканным db.any этого не ловят — SQL обязан
// проходить живой EXPLAIN на дев-БД). Поэтому колонки касания берутся
// скалярными подзапросами в RETURNING (там ссылка на cts легальна); LIMIT 5 —
// три подзапроса по PK на строку, копейки. LEFT JOIN clients ссылается только
// на e (обычную FROM-запись) — это разрешено, EXPLAIN проходит.
const LEASE_SQL =
  `UPDATE care_touch_sends cts
      SET attempts = cts.attempts + 1, last_attempt_at = NOW()
     FROM care_enrollments e
     JOIN care_programs p ON p.id = e.program_id
     JOIN salons sal ON sal.id = e.salon_id
     LEFT JOIN clients c ON c.id = e.client_id
    WHERE e.id = cts.enrollment_id
      AND cts.id IN (
        SELECT id FROM care_touch_sends
         WHERE status = 'scheduled' AND scheduled_at <= NOW()
           AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
         ORDER BY scheduled_at ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED)
    RETURNING cts.*, e.phone, e.status AS enrollment_status, e.staff_name, e.visit_at,
              e.services AS visit_services, e.program_id, e.client_id,
              p.is_enabled AS program_enabled, p.conditions AS program_conditions,
              p.title AS program_title, sal.name AS salon_name, c.name AS client_name,
              (SELECT t.intent_text FROM care_touches t WHERE t.id = cts.touch_id) AS intent_text,
              (SELECT t.title       FROM care_touches t WHERE t.id = cts.touch_id) AS touch_title,
              (SELECT t.delay_days  FROM care_touches t WHERE t.id = cts.touch_id) AS delay_days`;

async function processTick(deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const rows = await d.db.any(LEASE_SQL, [RETRY_BACKOFF_S]);
  for (const row of rows) {
    if (!row.touch_id || row.intent_text == null) {   // касание удалили из программы
      await markSend(d.db, row.id, 'cancelled', 'касание удалено из программы').catch(() => {});
      continue;
    }
    await processOne(row, d);
  }
}

let _running = false;
function startCareWorker() {
  if (_running) return;
  _running = true;
  if (!config.CHATPUSH.instanceToken) {
    log.warn('CHATPUSH_INSTANCE_TOKEN is not set — care worker disabled');
    return;
  }
  setInterval(() => { processTick().catch(e => log.error(`tick: ${e.message}`)); }, WORKER_TICK_MS);
  log.info(`Care worker started (tick=${WORKER_TICK_MS}ms)`);
}

// LEASE_SQL экспортируется для живой EXPLAIN-проверки (scripts / node -e):
// юнит-тесты мокают db.any и валидность SQL не проверяют.
module.exports = { processOne, processTick, startCareWorker, defaultDeps, LEASE_SQL };
