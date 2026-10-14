'use strict';
// ============================================================
// Воркер уведомлений: аренда due-строк notification_jobs, перепроверка состояния
// записи ПЕРЕД отправкой (напоминание о перенесённой/отменённой записи — хуже
// молчания), режим салона (off → ждём, shadow → журнал без отправки, live →
// отправка), захват mark-before-send (at-most-once, как в «Заботе»).
//
// Отправка — КАСКАДОМ (cascade.js): шаг = один мессенджер. Следующий шаг — только
// после ОДНОЗНАЧНОГО отказа (transport.isDefiniteRejection: 4xx, «нет аккаунта»,
// номер скрыт/не найден). Таймаут/5xx останавливают каскад: сообщение могло уйти,
// а дубль в другом мессенджере хуже пропуска.
//
// Через CHECK_DELAY_S после отправки — сверка статуса доставки: «Невозможно
// доставить» (status_id 5) возвращает строку в очередь со следующего шага. Ошибка
// чтения статуса считается «доставлено»: повтор в другой мессенджер дал бы дубль.
//
// Режим салона: live и shadow — работа; off и ЛЮБОЕ другое значение (fail-closed)
// — строка остаётся pending. Аренда уже прибавила attempts, и в off попытку
// ВОЗВРАЩАЕМ: иначе она копилась бы раз в минуту, и после включения live первый же
// сбой давал бы failed.
//
// ВАЖНО для at-most-once: после реальной отправки внутри цикла ничего не должно
// бросать. Строка, упавшая в общий catch processTick, возвращается в pending и
// уйдёт повторно. Поэтому журнал отправки и afterSend всё глотают, а блок после
// отправки обёрнут в собственный try/catch.
// ============================================================
const fs = require('fs');
const path = require('path');
const { db } = require('../../db');
const transport = require('../messaging/transport');
const settingsSvc = require('./settings');
const { lastConversation } = require('./rules');
const { buildCascade, recipientFor } = require('./cascade');
const pendingReplies = require('../agent/pending-replies');
const authorship = require('../outgoing-authorship');
const { persistWhatsappOutgoing } = require('../chat-persist');
const { createLogger } = require('../../logger');

const log = createLogger('NotifyWorker');
const TICK_MS = 10 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_S = 60;
const BATCH = 10;
const CHECK_DELAY_S = 120;
const UNDELIVERABLE_STATUS_ID = 5;
const REVIEW_REPEAT_DAYS = 30;
const uploadsDir = path.join(__dirname, '../../../frontend/uploads');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const EMPTY_CONV = Object.freeze({ lastChannel: null, chats: {} });

// Письма, которые клиент получает не чаще раза на телефон. Постановка в очередь уже
// отсекает повтор (enroll), но две записи могли лечь в очередь до отправки первой, поэтому
// решающая проверка — здесь, в момент отправки. days — окно давности; null — без окна.
const ONCE_PER_PHONE = {
  visit_review: { days: REVIEW_REPEAT_DAYS, reason: 'опрос уже отправлялся' },
  first_visit: { days: null, reason: 'приглашение уже отправлялось' },
};

// После правки — живой EXPLAIN на дев-БД (юнит-моки SQL не проверяют).
const LEASE_SQL = `
  UPDATE notification_jobs j
     SET attempts = j.attempts + 1, last_attempt_at = NOW()
   WHERE j.id IN (
     SELECT id FROM notification_jobs
      WHERE status = 'pending' AND scheduled_at <= NOW()
        AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
      ORDER BY scheduled_at ASC, id ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED)
   RETURNING j.*`;

// Сверка доставки: строку «забираем», обнуляя check_at, — второй тик её не увидит.
const CHECK_SQL = `
  UPDATE notification_jobs SET check_at = NULL
   WHERE id IN (
     SELECT id FROM notification_jobs
      WHERE status = 'sent' AND check_at IS NOT NULL AND check_at <= NOW()
      ORDER BY check_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED)
   RETURNING id, salon_id, channel_used, delivery_id, account_id, cascade_pos, routing`;

const step = (ch, res, err) => ({ ch, res, ...(err ? { err: String(err).slice(0, 200) } : {}), at: new Date().toISOString() });

/**
 * Смена статуса строки. Переход допустим только из pending (до захвата) и sent (после
 * захвата): отмену, сделанную параллельно (enroll.cancelPending), не затираем.
 * extra.clearSentAt — отправки не было: метка времени от захвата не должна остаться.
 */
async function setStatus(id, status, extra = {}) {
  await db.query(
    `UPDATE notification_jobs
        SET status=$2, error=$3, decision_reason=COALESCE($4, decision_reason),
            routing=COALESCE($5::jsonb, routing), cascade_log = cascade_log || $6::jsonb,
            sent_at = CASE WHEN $7::boolean THEN NULL ELSE sent_at END
      WHERE id=$1 AND status IN ('pending','sent')`,
    [id, status, extra.error || null, extra.reason || null, extra.routing ? JSON.stringify(extra.routing) : null,
     JSON.stringify(extra.steps || []), extra.clearSentAt === true]);
}

/** Режим off: аренда прибавила attempts, а попытки отправки не было — возвращаем. Не бросает. */
async function releaseLease(job) {
  try {
    await db.query(`UPDATE notification_jobs SET attempts = GREATEST(attempts-1,0) WHERE id=$1 AND status='pending'`, [job.id]);
  } catch (e) {
    log.warn(`#${job.id}: откат попытки аренды не удался: ${e.message}`);
  }
}

/**
 * Перепроверка по состоянию записи (notification_record_state). Возвращает причину отмены
 * или null.
 *  • Любое письмо, кроме record_cancelled, про отменённую запись (удалена / «не придёт») не
 *    уходит. У record_cancelled логика ОБРАТНАЯ: слать, только пока запись ВСЁ ЕЩЁ отменена —
 *    общее «запись отменена → гасим» погасило бы само письмо об отмене.
 *  • visit_reminder: перенос (время визита в состоянии другое) и подтверждение (attendance 2:
 *    Chatpush по подтверждённым не напоминает) гасят. first_visit с переносом НЕ сверяется —
 *    он ставится при создании записи и уходит сразу.
 *  • visit_review/visit_after: нужен attendance=1.
 *  • Любое: клиент в чёрном списке; visit_review/first_visit — «раз на телефон» (ONCE_PER_PHONE).
 * Тестовая отправка (meta.test) не проверяется вовсе.
 */
async function staleReason(job) {
  if (job.meta && job.meta.test) return null;
  const t = job.trigger_type;
  const st = await db.oneOrNone(
    'SELECT visit_datetime, attendance, deleted FROM notification_record_state WHERE salon_id=$1 AND yclients_record_id=$2',
    [job.salon_id, job.yclients_record_id]);
  if (st) {   // состояния нет (создано до выката) — по записи не мешаем
    const cancelledNow = !!st.deleted || Number(st.attendance) === -1;
    if (t === 'record_cancelled') {
      if (!cancelledNow) return 'запись восстановлена до отправки';
    } else if (cancelledNow) {
      return 'запись отменена к моменту отправки';
    }
    if (t === 'visit_reminder') {
      if (job.visit_datetime && st.visit_datetime
          && new Date(st.visit_datetime).getTime() !== new Date(job.visit_datetime).getTime()) return 'запись перенесена к моменту отправки';
      if (Number(st.attendance) === 2) return 'визит уже подтверждён';
    }
    if ((t === 'visit_review' || t === 'visit_after') && Number(st.attendance) !== 1) return 'статус «пришёл» снят';
  }

  // Без номера из 10 цифр LIKE '%' совпал бы с любым клиентом салона.
  const digits = String(job.phone || '').replace(/\D/g, '');
  if (digits.length >= 10) {
    const cl = await db.oneOrNone(
      'SELECT bool_or(COALESCE(is_blacklisted, FALSE)) AS is_blacklisted FROM clients WHERE salon_id=$1 AND phone LIKE $2',
      [job.salon_id, '%' + digits.slice(-10)]);
    if (cl && cl.is_blacklisted) return 'клиент в чёрном списке';
  }

  const once = ONCE_PER_PHONE[t];
  if (once && job.phone) {
    // Тестовые отправки администратора и сама строка в счёт не идут.
    const dup = await db.oneOrNone(
      `SELECT id FROM notification_jobs
        WHERE salon_id = $1 AND phone = $2 AND trigger_type = $3 AND id <> $4
          AND status IN ('sent','shadow') AND COALESCE(meta->>'test','') <> 'true'
          AND ($5::int IS NULL OR COALESCE(sent_at, scheduled_at) > NOW() - make_interval(days => $5::int))
        LIMIT 1`,
      [job.salon_id, job.phone, t, job.id, once.days]);
    if (dup) return once.reason;
  }
  return null;
}

function attachmentOf(url) {
  if (!url) return null;
  const fileName = path.basename(String(url));
  const ext = path.extname(fileName).toLowerCase();
  return { fileName, abs: path.join(uploadsDir, fileName), type: ext === '.pdf' ? 'document' : 'image', mime: MIME[ext] || 'application/octet-stream' };
}

/** target — адресат одного шага из cascade.recipientFor. */
async function deliver(job, target) {
  const att = attachmentOf(job.attachment_url);
  if (att) {
    // 400 — однозначный отказ: файла нет ни для одного мессенджера, но каскад честно пройдёт
    // все шаги и строка уйдёт в failed после последней попытки.
    if (!fs.existsSync(att.abs)) throw Object.assign(new Error(`файл вложения не найден: ${att.fileName}`), { status: 400 });
    return transport.sendFile(job.salon_id, { ...target, fileName: att.fileName, caption: job.rendered_text, type: att.type },
      fs.readFileSync(att.abs), att.mime);
  }
  return transport.sendMessage(job.salon_id, { ...target, text: job.rendered_text });
}

/**
 * Что нужно сделать ПОСЛЕ реальной отправки, чтобы Мила видела своё сообщение: транскрипт Милы
 * собирается из chatpush_messages, куда исходящее попадает только эхом (tdlib/MAX — с задержкой,
 * WhatsApp — не шлёт вовсе). Всё best-effort и НИЧЕГО не бросает наружу: сообщение уже ушло, а
 * исключение вернуло бы строку в очередь и отправило его ещё раз.
 */
async function afterSend(job, channelUsed, delivery) {
  try { pendingReplies.remember(job.salon_id, job.phone, job.rendered_text); }
  catch (e) { log.error(`pending #${job.id}: ${e.message}`); }
  // Автоуведомление — НАШЕ сообщение: без этой отметки его эхо выглядит как ответ живого
  // администратора и ставит Милу на паузу (инцидент 04.08).
  try { await authorship.remember(job.salon_id, job.phone, job.rendered_text, 'system'); }
  catch (e) { log.error(`authorship #${job.id}: ${e.message}`); }
  if (channelUsed === 'whatsapp' && delivery) {
    const att = attachmentOf(job.attachment_url);
    try {
      await persistWhatsappOutgoing(job.salon_id, {
        delivery, phone: job.phone, chatId: null, text: job.rendered_text,
        msgType: att ? att.type : 'text', fileUrl: job.attachment_url || null, mimeType: att ? att.mime : null,
        authoredBy: 'system',
      });
    } catch (e) { log.error(`persist wa #${job.id}: ${e.message}`); }
  }
}

/** Журнал успешной отправки + хвост. Не бросает (см. шапку). */
async function afterDelivery(job, ch, pos, total, delivery, steps) {
  try {
    const deliveryId = delivery && delivery.id != null ? String(delivery.id) : null;
    const accountId = delivery && delivery.accountId != null ? String(delivery.accountId) : null;
    // Сверять статус доставки можно только по id доставки.
    await db.query(
      `UPDATE notification_jobs SET channel_used=$2, delivery_id=$3, account_id=$4, cascade_pos=$5,
          check_at = CASE WHEN $6::double precision IS NULL THEN NULL ELSE NOW() + make_interval(secs => $6::double precision) END,
          error=NULL, cascade_log = cascade_log || $7::jsonb
        WHERE id=$1`,
      [job.id, ch, deliveryId, accountId, pos, deliveryId != null ? CHECK_DELAY_S : null, JSON.stringify(steps)]);
  } catch (e) {
    log.error(`#${job.id} journal after send: ${e.message}`);
  }
  log.info(`#${job.id} ${job.trigger_type} record=${job.yclients_record_id} sent via ${ch} (шаг ${pos + 1}/${total}) delivery=${delivery && delivery.id}`);
  await afterSend(job, ch, delivery);
}

async function conversationOf(job) {
  try {
    return (await lastConversation(job.salon_id, job.phone)) || EMPTY_CONV;
  } catch (e) {
    log.warn(`#${job.id}: переписка клиента не прочиталась (${e.message}) — каскад по настройкам`);
    return EMPTY_CONV;
  }
}

async function processOne(job, cfg) {
  const mode = cfg && cfg.mode;
  // live и shadow — работа. off и любое другое значение — fail-closed: ждём.
  if (mode !== 'live' && mode !== 'shadow') { await releaseLease(job); return; }

  const stale = await staleReason(job);
  if (stale) {
    await setStatus(job.id, 'cancelled', { reason: stale });
    log.info(`#${job.id} ${job.trigger_type} record=${job.yclients_record_id} cancelled: ${stale}`);
    return;
  }

  const conv = await conversationOf(job);
  // Продолжение после «Невозможно доставить» идёт по СОХРАНЁННОМУ каскаду: порядок не должен
  // меняться посреди одной отправки.
  const continuing = Number(job.cascade_pos) > 0 && Array.isArray(job.routing) && job.routing.length > 0;
  const cascade = continuing ? job.routing
    : buildCascade(cfg.default_channels, { preferLast: cfg.prefer_last_channel !== false, lastChannel: conv.lastChannel });
  if (!cascade.length) {
    await setStatus(job.id, 'failed', { error: 'в настройках не выбран ни один мессенджер для каскада' });
    return;
  }

  if (mode === 'shadow') {
    await setStatus(job.id, 'shadow', { routing: cascade, reason: 'теневой режим: не отправлено' });
    log.info(`#${job.id} ${job.trigger_type} shadow cascade=[${cascade.join(',')}]`);
    return;
  }

  // Захват ДО отправки: если строку отменили между арендой и этим моментом — не шлём. Заодно
  // чистим check_at и error прошлых кругов. Падение процесса после захвата теряет сообщение,
  // но не дублирует его — выбор at-most-once.
  const cap = await db.query(
    `UPDATE notification_jobs SET status='sent', sent_at=NOW(), routing=$2::jsonb, check_at=NULL, error=NULL
      WHERE id=$1 AND status='pending'`,
    [job.id, JSON.stringify(cascade)]);
  if (!cap.rowCount) { log.info(`#${job.id}: захват не удался — строка уже не pending`); return; }

  const steps = [];
  for (let pos = Number(job.cascade_pos) || 0; pos < cascade.length; pos++) {
    const ch = cascade[pos];
    const target = recipientFor(ch, job.phone, conv.chats || {});
    if (!target) { steps.push(step(ch, 'no_recipient')); continue; }
    let delivery;
    try {
      delivery = await deliver(job, target);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!transport.isDefiniteRejection(e)) {
        steps.push(step(ch, 'ambiguous', msg));
        log.warn(`#${job.id} ${ch} ambiguous, cascade stopped: ${msg}`);
        // Не записался failed → строка остаётся sent (захват): повторной отправки не будет.
        // Бросить отсюда нельзя — общий catch вернул бы её в pending и сообщение ушло бы дважды.
        await setStatus(job.id, 'failed', { steps,
          error: `${ch}: неоднозначный сбой (${msg}) — дальше по каскаду не идём, сообщение могло уйти` })
          .catch((err) => log.error(`#${job.id} failed-mark: ${err.message}`));
        return;
      }
      steps.push(step(ch, 'rejected', msg));
      log.info(`#${job.id} ${ch} отказал (${msg}) — следующий мессенджер`);
      continue;
    }
    // Отправлено. Дальше НИЧЕГО не бросает: любая ошибка ниже вернула бы строку в очередь.
    steps.push(step(ch, 'sent'));
    try {
      await afterDelivery(job, ch, pos, cascade.length, delivery, steps);
    } catch (e) {
      log.error(`#${job.id} after send: ${e.message}`);
    }
    return;
  }

  const final = Number(job.attempts) >= MAX_ATTEMPTS;
  await setStatus(job.id, final ? 'failed' : 'pending', { steps, clearSentAt: true,
    error: `ни один мессенджер не принял: ${steps.map((s) => `${s.ch}=${s.res}`).join(', ')}` });
  log.warn(`#${job.id} cascade exhausted (attempt ${job.attempts}/${MAX_ATTEMPTS})`);
}

async function checkOne(r) {
  if (r.delivery_id == null) return;
  let st;
  try {
    st = await transport.getDeliveryStatus(r.salon_id, r.channel_used, r.delivery_id, { accountId: r.account_id });
  } catch (e) {
    // Не знаем судьбу — считаем доставленным: повтор в другой мессенджер дал бы дубль.
    log.warn(`#${r.id} delivery check failed: ${e.message}`);
    return;
  }
  if (!st || !st.status || Number(st.status.status_id) !== UNDELIVERABLE_STATUS_ID) return;
  const next = (Number(r.cascade_pos) || 0) + 1;
  const hasNext = Array.isArray(r.routing) && next < r.routing.length;
  await db.query(
    `UPDATE notification_jobs SET status=$2, cascade_pos=$3, scheduled_at=NOW(), attempts=0, last_attempt_at=NULL,
        error=$4, cascade_log = cascade_log || $5::jsonb
      WHERE id=$1 AND status='sent'`,
    [r.id, hasNext ? 'pending' : 'failed', hasNext ? next : Number(r.cascade_pos) || 0,
     `${r.channel_used}: «Невозможно доставить»${hasNext ? ' — следующий мессенджер' : ' — мессенджеры закончились'}`,
     JSON.stringify([step(r.channel_used, 'undeliverable')])]);
  log.info(`#${r.id} ${r.channel_used} не доставлено → ${hasNext ? `шаг ${next + 1}` : 'failed'}`);
}

async function checkDeliveries() {
  const rows = await db.any(CHECK_SQL, [BATCH]);
  for (const r of rows) {
    // check_at у забранных строк уже обнулён: сбой на одной не должен терять сверку остальных.
    try { await checkOne(r); } catch (e) { log.error(`#${r.id} delivery check: ${e.message}`); }
  }
}

async function processTick() {
  const rows = await db.any(LEASE_SQL, [RETRY_BACKOFF_S, BATCH]);
  for (const row of rows) {
    try {
      const cfg = await settingsSvc.getSettings(row.salon_id);
      await processOne(row, cfg);
    } catch (e) {
      log.error(`#${row.id}: ${e.message}`);
      // Сюда попадают только сбои ДО отправки (после неё код не бросает): строка вернётся на повтор.
      await setStatus(row.id, Number(row.attempts) >= MAX_ATTEMPTS ? 'failed' : 'pending',
        { error: String((e && e.message) || e).slice(0, 500) }).catch(() => {});
    }
  }
  await checkDeliveries().catch((e) => log.error(`delivery checks: ${e.message}`));
}

let _running = false;
let _inFlight = false;
function startNotificationWorker() {
  if (_running) return;
  _running = true;
  if (!transport.configured()) {
    log.warn('ни CHATPUSH_INSTANCE_TOKEN, ни MESSAGING_GATEWAY_URL не заданы — notification worker disabled');
    return;
  }
  setInterval(() => {
    if (_inFlight) return;
    _inFlight = true;
    processTick().catch((e) => log.error(`tick: ${e.message}`)).finally(() => { _inFlight = false; });
  }, TICK_MS);
  log.info(`Notification worker started (tick=${TICK_MS}ms)`);
}

module.exports = { processTick, processOne, checkDeliveries, startNotificationWorker, LEASE_SQL, CHECK_SQL, staleReason };
