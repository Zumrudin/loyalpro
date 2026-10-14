'use strict';
// ============================================================
// handleRecordEvent(salon, payload, nowMs) — зовётся из routes/webhook.js на
// КАЖДОМ record-событии YClients. Обновляет notification_record_state, по
// разнице со старым состоянием классифицирует событие и ставит job'ы по
// совпавшим правилам. Пропуски (нет телефона, ЧС) — строки skipped с причиной:
// «почему не пришло» разбирается по журналу. Запись, созданную Милой, пропуском
// НЕ является: «Вы записаны» уходит и по ней (решение владельца 14.10.2026).
// Режим off → только состояние (нужно, чтобы при включении shadow/live перенос
// и «пришёл» распознавались сразу, а не с первого события после включения).
//
// ПАРИТЕТ С YCLIENTS/CHATPUSH (классификатор сверен с 8 634 реальными вебхуками и
// тем, что Chatpush реально отправил). Отступать от этих правил — значит слать
// клиентам письма, которых раньше не было:
//  • Мгновенные record_created / record_rescheduled / record_cancelled — только про
//    БУДУЩИЙ визит (visitAt > now). Запись задним числом и после начала визита
//    Chatpush не уведомляет (администратор вносит уже состоявшееся).
//  • record_cancelled шлётся ТОЛЬКО на отметку «клиент не придёт» (attendance -1) до
//    начала визита. on_no_show = «слать, когда поставили «клиент не придёт» до начала
//    визита; удаление не уведомляет — как YClients» (у Chatpush 0 писем «отменена» на
//    58 удалений). Запланированное (pending) гасится при ЛЮБОЙ отмене, письмо или нет.
//  • Возврат из отмены (restored) и перенос туда-обратно (A→B→A) возвращают
//    напоминание: ключ job'а (правило, запись, момент визита) у A уже занят погашенной
//    строкой, и insertJob её ОЖИВЛЯЕТ (ON CONFLICT … DO UPDATE … WHERE status='cancelled').
//    Строки в другом статусе (sent/pending/shadow/…) не трогаются — дубля не будет.
//  • visit_review — не чаще раза в 30 дней на телефон (иначе несколько записей одного
//    дня дают несколько опросов): повтор ложится строкой skipped с причиной.
// ============================================================
const { db } = require('../../db');
const { createLogger } = require('../../logger');
const settingsSvc = require('./settings');
const ev = require('./events');
const { evaluateRule, getServiceCategoryMap } = require('./rules');
const { renderTemplate, buildRenderCtx } = require('./render');
const salonNames = require('../../utils/salon-names');

const log = createLogger('NotifyEnroll');

const REVIEW_REPEAT_REASON = 'опрос уже был за 30 дней';

async function loadState(salonId, recordId) {
  const row = await db.oneOrNone(
    'SELECT * FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = $2', [salonId, recordId]);
  if (!row) return null;
  return { ...row, visitAt: row.visit_datetime ? new Date(row.visit_datetime).getTime() : null };
}

async function saveState(salonId, snap) {
  await db.query(
    `INSERT INTO notification_record_state (salon_id, yclients_record_id, visit_datetime, seance_length, attendance, deleted,
        services, staff_id, client_yc_id, phone, created_user_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,NOW())
     ON CONFLICT (salon_id, yclients_record_id) DO UPDATE SET visit_datetime=EXCLUDED.visit_datetime,
        seance_length=EXCLUDED.seance_length, attendance=EXCLUDED.attendance, deleted=EXCLUDED.deleted,
        services=EXCLUDED.services, staff_id=EXCLUDED.staff_id, client_yc_id=EXCLUDED.client_yc_id,
        phone=COALESCE(EXCLUDED.phone, notification_record_state.phone), created_user_id=EXCLUDED.created_user_id, updated_at=NOW()`,
    [salonId, snap.recordId, snap.visitAt != null ? new Date(snap.visitAt) : null, snap.seanceLength, snap.attendance,
     snap.deleted, JSON.stringify(snap.services), snap.staffId, snap.clientYcId, snap.phone, snap.createdUserId]);
}

async function cancelPending(salonId, recordId, reason, onlyTypes = null) {
  const res = await db.query(
    `UPDATE notification_jobs SET status='cancelled', decision_reason=$3
      WHERE salon_id=$1 AND yclients_record_id=$2 AND status='pending'
        AND ($4::text[] IS NULL OR trigger_type = ANY($4::text[]))`,
    [salonId, recordId, reason, onlyTypes]);
  return res.rowCount || 0;
}

/**
 * Один job на (правило, запись, момент визита). Повтор вебхука — тот же ключ: если строка в
 * работе или уже обработана, ничего не меняется; если она ПОГАШЕНА (перенос, отмена «не придёт»
 * и возврат), её оживляем свежими значениями — иначе перенос A→B→A оставил бы визит A без
 * напоминания (ключ A занят погашенной строкой). Аренду, каскад и счётчики попыток сбрасываем.
 * Порядок параметров — контракт с тестами и backfillReminders (Task 11).
 */
async function insertJob(salonId, rule, snap, client, scheduledMs, text, extra = {}) {
  const res = await db.query(
    `INSERT INTO notification_jobs (salon_id, rule_id, trigger_type, rule_title, yclients_record_id, visit_datetime, scheduled_at,
        client_id, rendered_text, status, phone, attachment_url, meta, decision_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     ON CONFLICT (rule_id, yclients_record_id, COALESCE(visit_datetime, 'epoch'::timestamptz))
     DO UPDATE SET status=EXCLUDED.status, scheduled_at=EXCLUDED.scheduled_at, rendered_text=EXCLUDED.rendered_text,
        meta=EXCLUDED.meta, decision_reason=EXCLUDED.decision_reason, phone=EXCLUDED.phone,
        rule_title=EXCLUDED.rule_title, client_id=EXCLUDED.client_id, attachment_url=EXCLUDED.attachment_url,
        attempts=0, error=NULL, last_attempt_at=NULL, routing=NULL, cascade_pos=0, cascade_log='[]'::jsonb,
        created_at=NOW()
     WHERE notification_jobs.status='cancelled'`,
    [salonId, rule.id, rule.trigger_type, rule.title, snap.recordId,
     snap.visitAt != null ? new Date(snap.visitAt) : null, new Date(scheduledMs),
     client ? client.id : null, text, extra.status || 'pending', snap.phone, rule.attachment_url || null,
     JSON.stringify({ askConfirmation: !!rule.ask_confirmation, ...(extra.meta || {}) }),
     extra.reason || null]);
  if (res.rowCount) log.info(`job ${rule.trigger_type} rule=${rule.id} record=${snap.recordId} → ${extra.status || 'pending'}${extra.reason ? ': ' + extra.reason : ''}`);
  return res.rowCount || 0;
}

/**
 * Сколько состоявшихся визитов клиента начались не позже этого. Саму запись исключаем по id, а
 * сравнение «не позже» (<=) нужно для записей на ОДИН момент к разным мастерам: пока для первой
 * ставится приглашение, вторая видит первую как прошлый визит и второго приглашения не получает.
 * 'completed' — тоже состоявшийся (status_id 4), как в refreshLastVisitAt.
 */
async function priorArrivedVisits(salonId, clientId, recordId, beforeMs) {
  if (!clientId) return 0;
  const row = await db.oneOrNone(
    `SELECT count(*)::int AS n FROM records
      WHERE salon_id = $1 AND client_id = $2 AND status IN ('arrived','completed')
        AND yclients_record_id <> $3 AND visit_datetime <= $4`,
    [salonId, clientId, recordId, new Date(beforeMs)]);
  return row ? Number(row.n) : 0;
}

/** Был ли этому телефону опрос (в работе, отправленный или теневой) за последние 30 дней. */
async function recentReviewExists(salonId, phone) {
  const row = await db.oneOrNone(
    `SELECT 1 AS hit FROM notification_jobs
      WHERE salon_id = $1 AND phone = $2 AND trigger_type = 'visit_review'
        AND status IN ('pending','sent','shadow')
        AND created_at > NOW() - INTERVAL '30 days'
      LIMIT 1`,
    [salonId, phone]);
  return !!row;
}

// 0 — законное значение (валидация правила 0..1440), поэтому `|| 5` нельзя: он превращал 0 в 5.
const delayOf = (rule, dflt) => (rule.delay_minutes == null ? dflt : rule.delay_minutes);

async function handleRecordEvent(salon, payload, nowMs = Date.now()) {
  const snap = ev.recordSnapshot(payload);
  if (!Number.isInteger(snap.recordId)) return;
  const salonId = salon.id;
  const prev = await loadState(salonId, snap.recordId);
  const kinds = ev.classifyRecordEvent(prev, snap);
  await saveState(salonId, snap);

  const cfg = await settingsSvc.getSettings(salonId);
  if (cfg.mode === 'off') return;

  // Отмена/перенос гасят запланированное ВСЕГДА, даже без правил на эти события и даже когда
  // письма об отмене не будет (удаление записи).
  if (kinds.cancelled) await cancelPending(salonId, snap.recordId, 'запись отменена');
  if (kinds.rescheduled) await cancelPending(salonId, snap.recordId, 'запись перенесена', ['visit_reminder', 'first_visit']);

  const rules = await db.any(
    'SELECT * FROM notification_rules WHERE salon_id = $1 AND is_enabled = TRUE', [salonId]);
  if (!rules.length) return;

  const catMap = await getServiceCategoryMap(salon).catch(() => new Map());
  const serviceIds = snap.services.map((s) => s.id);
  const ctx = { staffId: snap.staffId, serviceIds,
    categoryIds: [...new Set(serviceIds.map((id) => catMap.get(String(id))).filter(Boolean))] };
  const matches = (r) => { try { return evaluateRule(r.conditions, ctx); } catch (e) { log.warn(`rule #${r.id}: ${e.message}`); return false; } };

  const client = snap.clientYcId ? await db.oneOrNone(
    'SELECT id, name, is_blacklisted FROM clients WHERE salon_id = $1 AND yclients_client_id = $2', [salonId, snap.clientYcId]) : null;
  const renderCtx = buildRenderCtx(snap, salon, client, { nameDictionary: await salonNames.load(salonId).catch(() => null) });

  // Мгновенные письма — только про будущий визит (паритет с Chatpush, см. шапку).
  const visitAhead = snap.visitAt != null && snap.visitAt > nowMs;
  const baseSkipReason = !snap.phone ? 'нет телефона клиента'
    : (client && client.is_blacklisted ? 'клиент в чёрном списке' : null);
  const put = async (rule, atMs, { meta, reason } = {}) => {
    const skip = baseSkipReason || reason || null;
    const text = renderTemplate(rule.message_template, renderCtx);
    return insertJob(salonId, rule, snap, client, atMs, text, skip ? { status: 'skipped', reason: skip } : { meta });
  };

  const applyRule = async (rule) => {
    const t = rule.trigger_type;
    if (t === 'record_created' && kinds.created && visitAhead && matches(rule)) await put(rule, nowMs);
    if (t === 'record_rescheduled' && kinds.rescheduled && visitAhead && matches(rule)) await put(rule, nowMs);
    // Удаление записи не уведомляет: noShow = отметка «не придёт» БЕЗ удаления (events.classifyRecordEvent).
    if (t === 'record_cancelled' && kinds.noShow && visitAhead && rule.on_no_show !== false && matches(rule)) await put(rule, nowMs);

    if (t === 'visit_reminder' && (kinds.created || kinds.rescheduled || kinds.restored) && matches(rule)) {
      const at = ev.reminderAt(snap, rule, cfg, nowMs);
      if (at != null) await put(rule, at); else log.info(`reminder rule=${rule.id} record=${snap.recordId}: момент уже прошёл — не ставим`);
    }
    if (t === 'visit_review' && kinds.arrived && matches(rule)) {
      const repeat = !baseSkipReason && await recentReviewExists(salonId, snap.phone);
      await put(rule, ev.applyQuietHours(ev.afterVisitAt(snap, delayOf(rule, 5), nowMs), cfg),
        { reason: repeat ? REVIEW_REPEAT_REASON : null });
    }
    if (t === 'visit_after' && kinds.arrived && matches(rule)) {
      await put(rule, ev.applyQuietHours(ev.afterVisitAt(snap, delayOf(rule, 7), nowMs), cfg));
    }
    if (t === 'first_visit' && kinds.arrived && matches(rule)) {
      const prior = await priorArrivedVisits(salonId, client && client.id, snap.recordId, snap.visitAt != null ? snap.visitAt : nowMs);
      if (prior === 0) await put(rule, nowMs); else log.info(`first_visit rule=${rule.id} record=${snap.recordId}: уже был ${prior} визит(ов) — пропуск`);
    }
  };

  // Сбой одного правила (шаблон, БД) не должен лишать остальные правила этого же события:
  // состояние записи уже сохранено, и повторно это событие не придёт.
  for (const rule of rules) {
    try {
      await applyRule(rule);
    } catch (e) {
      log.error(`rule #${rule.id} (${rule.trigger_type}) record=${snap.recordId}: ${e.message}`);
    }
  }
}

module.exports = { handleRecordEvent, cancelPending, _loadState: loadState };
