'use strict';
// Воркер «Отдела заботы». Аренда due-строк как в notification-воркере
// (FOR UPDATE SKIP LOCKED + attempts при аренде), затем на каждую строку:
// детерминированные проверки → care-проход LLM → отправка → персист.
// Все внешние зависимости инжектируются (юнит-тесты без БД/сети).
//
// Доставка — AT-MOST-ONCE (ревью 2026-08-02): пропущенное касание дешевле
// дубля живому пациенту, это философия фичи. Отсюда mark-before-send и
// правила catch-разбора (см. блок отправки в processOne).
//
// Ответы пациента на касание обрабатывает ОСНОВНОЙ агент Милы (обычный
// вебхук-путь со всеми мед-границами) — воркер в это не вмешивается;
// rememberPending лишь подмешивает отправленное касание в транскрипт
// основного агента до прихода эха Chatpush.

const config = require('../../config');
const { db: realDb } = require('../../db');
const chatpush = require('../chatpush');
const { persistWhatsappOutgoing } = require('../chat-persist');
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
// Таймаут care-прохода LLM: зависший провайдер не должен держать строку (и
// тик) вечно. 60с < backoff аренды 120с — таймаут-ретрай не пересечётся с
// ещё живым прошлым вызовом в окне аренды.
const LLM_TIMEOUT_MS  = 60000;

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
  // Персист исходящего касания в chatpush_messages (WhatsApp не шлёт эхо на
  // свои же отправки — без этого шага сообщение живёт лишь в транскрипте
  // pendingReplies и пропадает из истории чата после перезагрузки).
  persistWhatsapp: (salonId, { delivery, phone, text }) =>
    persistWhatsappOutgoing(salonId, { delivery, phone, chatId: null, text, msgType: 'text' }),
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

// Отложить касание на сутки (НЕ терминальный skip): строка остаётся
// scheduled и видна в дашборде, бюджет попыток обнуляется. Тот же приём,
// что анти-спам «1 касание в день» ниже — вынесено в хелпер, чтобы не
// дублировать SQL. База сдвига — max(scheduled_at, now()): просроченная
// строка уезжает в будущее ОДНИМ шагом, а не по дню за тик.
async function deferTouch(db, row, reason) {
  const base = Math.max(new Date(row.scheduled_at || Date.now()).getTime(), Date.now());
  await db.query(
    `UPDATE care_touch_sends SET scheduled_at=$2, attempts=0, last_attempt_at=NULL,
            decision_reason=$3
      WHERE id=$1`,
    [row.id, plusOneDay(new Date(base)), reason]);
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

  // Флаги для catch-разбора (инвариант at-most-once, см. блок отправки):
  let sentMarked = false;      // sent-маркер записан ДО отправки (откат в scheduled допустим)
  let delivered = false;       // sendMessage вернулся успешно (статус НЕ откатывать НИКОГДА)
  let terminalWritten = false; // терминальный skipped/cancelled в БД (статус НЕ перезаписывать)

  // Терминальный исход + проверка завершения цепочки: ЛЮБОЙ терминальный
  // статус последнего касания обязан завершить enrollment (в т.ч.
  // детерминированные skip'ы — иначе enrollment зависает active навсегда с
  // нулём scheduled: зомби в дашборде). Ошибка проверки цепочки логируется,
  // но НЕ откатывает уже записанный терминальный статус.
  const finish = async (status, reason) => {
    await markSend(db, row.id, status, reason);
    terminalWritten = true;
    await maybeCompleteChain(db, row.enrollment_id)
      .catch(e => d.log.error(`chain check #${row.id}: ${e.message}`));
  };

  try {
    // ── детерминированные проверки ─────────────────────────────
    if (row.enrollment_status !== 'active') {
      return finish('cancelled', `enrollment ${row.enrollment_status}`);
    }
    if (!row.program_enabled) return finish('skipped', 'программа выключена');
    if (!d.agentGloballyEnabled()) {
      // Env kill-switch НЕ означает «этой цепочке нельзя навсегда» — это
      // временное состояние проекта (Мила выключена сейчас, может включиться
      // через час). Терминальный skip здесь сжигал бы цепочку молча (ревью
      // 2026-08-02: касания дозревали при выключенном env и терялись
      // безвозвратно, at-most-once не даёт второго шанса). Откладываем на
      // сутки — строка остаётся scheduled и видна в дашборде, при включении
      // env уйдёт сама.
      await deferTouch(db, row, 'отложено: агент выключен (env)');
      return;
    }

    const gate = await d.isAllowed(sid, row.phone);   // fail-closed: throw → catch ниже
    if (!gate.allow) {
      // 'outside-schedule' — литерал из services/agent-gate.js (decideGate):
      // расписание Милы проектировалось для ВХОДЯЩИХ сообщений, а не для
      // исходящих care-касаний; вне окна режим принудительно сужается до
      // whitelist, и дневное касание (напр. send_time 10:30) получило бы
      // терминальный skip каждый раз. Откладываем на сутки вместо этого.
      // ВНИМАНИЕ: сдвиг на +24ч сохраняет время суток — если окно
      // расписания постоянное (напр. всегда ночное), касание будет вечно
      // откладываться и висеть scheduled в дашборде. Это ОСОЗНАННО:
      // видимость в дашборде лучше молчаливой смерти цепочки.
      if (gate.reason === 'outside-schedule') {
        await deferTouch(db, row, 'отложено: вне окна расписания агента');
        return;
      }
      // Прочие причины (whitelist/blacklist/disabled per-salon) — это
      // «этому клиенту/салону нельзя», а не «сейчас нельзя» → терминальный skip.
      return finish('skipped', `гейт Милы: ${gate.reason}`);
    }

    const dlg = await d.dialogStatus(sid, row.phone);
    if (dlg === 'escalated') return finish('skipped', 'диалог на операторе');

    if (await d.sentTodayExists(sid, row.phone)) {
      // Анти-спам «1 касание в день»: сдвигаем на завтра (см. deferTouch).
      await deferTouch(db, row, 'анти-спам: сдвинуто на день');
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
      return finish('cancelled', 'повторный визит состоялся');
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
      touch: { title: row.touch_title, intent_text: row.intent_text, text_mode: row.text_mode },
      enrollment: { staff_name: row.staff_name, visit_at: row.visit_at, services: row.visit_services },
      transcript: trList, futureBookings,
    });
    // maxTokens — дефолт провайдера (AGENT_MAX_TOKENS, 4096), как у основного
    // агента. Урок e2e-смоука 2026-08-03: ручной бюджет 1200 (посчитанный под
    // «1500 символов текста + JSON-конверт») не учитывал, что у reasoning-модели
    // (gemini-2.5-pro через Polza) reasoning-токены СЧИТАЮТСЯ в max_tokens —
    // на текст оставалось ~50 токенов, JSON обрезался (finish=length) и КАЖДОЕ
    // касание молча падало в fail-safe skip (llm_no_json). Таймаут через
    // Promise.race (провайдер не трогаем): по истечении — throw → общий catch
    // → ретрай строки.
    let resp;
    let llmTimer;
    try {
      resp = await Promise.race([
        d.createMessage(
          { system, messages: [{ role: 'user', content: user }] },
          {}),
        new Promise((_, reject) => {
          llmTimer = setTimeout(() => reject(new Error(`care LLM timeout ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS);
          if (llmTimer.unref) llmTimer.unref();
        }),
      ]);
    } finally { clearTimeout(llmTimer); }
    const decision = parseCareDecision(resp && resp.text);

    if (decision.action === 'escalate') {
      // Осложнение в переписке: касание НЕ отправляем, к пациенту как можно
      // скорее подключается человек. Порядок сознательный: сначала перевод
      // диалога на оператора — если он упадёт, общий catch вернёт строку на
      // ретрай и эскалация будет повторена (а не потеряна с уже-skipped строкой).
      const why = decision.reason || 'осложнение в переписке';
      await d.escalateDialog(sid, row.phone, why);
      await stopEnrollment(db, row.enrollment_id, 'escalated', why);
      return finish('skipped', `Мила: эскалация — ${why}`);
    }
    if (decision.action === 'stop_program') {
      await stopEnrollment(db, row.enrollment_id, decision.status, decision.reason);
      return finish('cancelled', `Мила: ${decision.reason}`);
    }
    if (decision.action === 'skip') {
      return finish('skipped', `Мила: ${decision.reason}`);
    }

    const viol = d.hardViolations(d.lintReply(decision.text, {}));
    if (viol.length) {
      return finish('skipped', `reply-guard: ${viol.map(v => v.type).join(',')}`);
    }

    // ── отправка: AT-MOST-ONCE (mark-before-send) ──────────────
    // Пропущенное касание дешевле дубля живому пациенту. Разбор отказов:
    //  1) UPDATE sent УПАЛ → отправка не выполняется → общий catch вернёт
    //     строку на ретрай. Дубля нет.
    //  2) UPDATE sent прошёл, sendMessage УПАЛ → catch (sentMarked &&
    //     !delivered): вернуть строку в scheduled — отправки не было, ретрай
    //     безопасен; если и этот возврат упал — строка остаётся 'sent' без
    //     доставки = пропущенное касание. Приемлемо by design.
    //  3) sendMessage ПРОШЁЛ, дальше что-то упало → catch при delivered=true
    //     НИКОГДА не откатывает статус в scheduled; best-effort re-mark
    //     'sent' + ERROR-лог.
    const last = await d.lastIncomingChannel(sid, row.phone).catch(() => null);
    const routing = notifications.resolveRouting([], true, last);   // дефолт telegram→whatsapp

    // 1) sent-маркер ДО отправки (delivery_id/channel_used дозаписываются после).
    //    Условие AND status='scheduled' ОБЯЗАТЕЛЬНО — это ПОСЛЕДНИЙ гейт перед
    //    отправкой: row.enrollment_status снят в момент аренды и в LIMIT-5
    //    батче устаревает. Сценарий: два касания одного enrollment в одном
    //    батче, строка A обработана первой, LLM решил stop_program declined →
    //    stopEnrollment отменил строку B (scheduled→cancelled), но цикл берёт
    //    B с арендованным status='active' — без условия маркер перезаписал бы
    //    cancelled→sent и пациенту, только что попросившему не писать, ушло бы
    //    сообщение. Та же защита закрывает межпроцессную гонку за строку.
    const marked = await db.query(
      `UPDATE care_touch_sends
          SET status='sent', sent_at=NOW(), error=NULL, decision_reason=$2,
              rendered_text=$3, routing=$4::jsonb
        WHERE id=$1 AND status='scheduled'`,
      [row.id, `Мила: ${decision.reason}`, decision.text, JSON.stringify(routing)]);
    if (!marked || !marked.rowCount) {
      // Строкой владеет другой исход (cancelled/skipped/…) — не отправляем и
      // ничего не откатываем (перезапись чужого терминального статуса хуже
      // пропущенного касания).
      d.log.info(`send #${row.id}: строка перехвачена другим исходом — не отправляем`);
      return;
    }
    sentMarked = true;

    // 2) отправка.
    const delivery = await d.sendMessage({ text: decision.text, phone: row.phone, dispatchRouting: routing });
    delivered = true;
    // Единственный след для разбора «ушло дважды / не ушло» — пишется до
    // любых пост-обработок.
    d.log.info(`delivered #${row.id} delivery=${delivery && delivery.id}`);

    // 3) best-effort дозапись реквизитов доставки (падение — не катастрофа).
    const channelUsed = (delivery && (delivery.channel || delivery.messenger)) || routing[0] || null;
    await db.query(
      `UPDATE care_touch_sends SET delivery_id=$2, channel_used=$3 WHERE id=$1`,
      [row.id, delivery && delivery.id != null ? String(delivery.id) : null, channelUsed]
    ).catch(e => d.log.error(`persist delivery #${row.id}: ${e.message}`));

    // Транскрипт/чат: pending до прихода эха; whatsapp эха не шлёт — персист сразу.
    d.rememberPending(sid, row.phone, decision.text);
    if (channelUsed === 'whatsapp') {
      await d.persistWhatsapp(sid, { delivery, phone: row.phone, text: decision.text })
        .catch(e => d.log.error(`persist wa: ${e.message}`));
    }
    d.log.info(`sent #${row.id} enrollment=${row.enrollment_id} routing=[${routing.join(',')}]`);
    await maybeCompleteChain(db, row.enrollment_id)
      .catch(e => d.log.error(`chain check #${row.id}: ${e.message}`));
  } catch (e) {
    // Инвариант at-most-once (разбор отказов — над блоком отправки).
    if (delivered) {
      // Доставлено пациенту — статус НЕ откатывать НИКОГДА: ретрай = дубль.
      d.log.error(`send #${row.id}: доставлено, но пост-обработка упала: ${e.message}`);
      await d.db.query(
        `UPDATE care_touch_sends SET status='sent', error=$2 WHERE id=$1`,
        [row.id, String(e.message || e).slice(0, 500)]
      ).catch(() => {});
      return;
    }
    if (terminalWritten) {
      // Терминальный skipped/cancelled уже в БД — не перезаписывать, только лог.
      d.log.error(`send #${row.id}: терминальный статус записан, хвост упал: ${e.message}`);
      return;
    }
    // Отправки не было (в т.ч. sentMarked без delivered: sent-маркер записан,
    // но sendMessage упал) — возврат в scheduled безопасен; после MAX_ATTEMPTS
    // ретраи исчерпаны → failed.
    // При откате sent-маркера чистим и sent_at — иначе на строке остаётся
    // отметка времени несостоявшейся отправки и форензика путается.
    const final = row.attempts >= MAX_ATTEMPTS;
    await d.db.query(
      `UPDATE care_touch_sends SET status='${final ? 'failed' : 'scheduled'}'${sentMarked ? ', sent_at=NULL' : ''}, error=$2 WHERE id=$1`,
      [row.id, String(e.message || e).slice(0, 500)]
    ).catch(() => {});
    d.log.warn(`send #${row.id} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${e.message}` +
      (sentMarked ? ' (sent-маркер откатан)' : ''));
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
              (SELECT t.delay_days  FROM care_touches t WHERE t.id = cts.touch_id) AS delay_days,
              (SELECT t.text_mode   FROM care_touches t WHERE t.id = cts.touch_id) AS text_mode`;

// setInterval не ждёт предыдущий тик: медленный прогон (LLM до 60с на строку,
// до 5 строк) наслаивался бы на следующий. Guard пропускает тик, пока прошлый
// жив — аренда с SKIP LOCKED и так не отдаст те же строки (в окне backoff),
// но наслоение множит соединения и ломает разбор логов.
let _tickInFlight = false;

async function processTick(deps = defaultDeps) {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    const d = { ...defaultDeps, ...deps };
    const rows = await d.db.any(LEASE_SQL, [RETRY_BACKOFF_S]);
    for (const row of rows) {
      if (!row.touch_id || row.intent_text == null) {   // касание удалили из программы
        // Терминальный cancel — тоже проверить завершение цепочки (иначе
        // enrollment с единственным удалённым касанием — зомби навсегда).
        await markSend(d.db, row.id, 'cancelled', 'касание удалено из программы').catch(() => {});
        await maybeCompleteChain(d.db, row.enrollment_id)
          .catch(e => d.log.error(`chain check #${row.id}: ${e.message}`));
        continue;
      }
      await processOne(row, d);
    }
  } finally {
    _tickInFlight = false;
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
