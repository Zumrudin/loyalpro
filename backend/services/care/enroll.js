'use strict';
// Зачисление в программы заботы. Триггер — вебхук записи, у которой визит
// СОСТОЯЛСЯ: attendance=1 ИЛИ paid_full=1 (именно ИЛИ — кэшбэчный критерий
// «оплачено деньгами» тут не годится: визит с оплатой бонусами тоже
// заслуживает заботы). Дедуп повторных доставок — UNIQUE (program_id, record_id).
//
// Повторный подходящий визит (курсовой клиент): прежний активный enrollment
// той же программы → 'superseded', его будущие касания → 'cancelled', цепочка
// стартует заново от нового визита — но ТОЛЬКО если новый визит действительно
// позже прежнего (см. supersede-блок ниже, ревизия после код-ревью).
//
// Отмена записи / неявка (delete-вебхук или attendance=-1) гасит уже
// зачисленные цепочки этой записи — см. classifyRecordEvent('unenroll').

const { db } = require('../../db');
const { evaluateRule, getServiceCategoryMap } = require('../notifications');
const { normalizePhoneKey } = require('../agent-gate');
const { parseVisitAt, computeScheduledAt } = require('./schedule');
const { createLogger } = require('../../logger');

const log = createLogger('CareEnroll');

/** Визит состоялся? attendance=1 ИЛИ paid_full=1. */
function isVisitCompleted(data) {
  if (!data) return false;
  return Number(data.attendance) === 1 || Number(data.paid_full) === 1;
}

/**
 * Чистая классификация вебхука записи для «Отдела заботы»:
 *   'unenroll' — запись удалена/отменена ИЛИ клиент не пришёл (attendance=-1).
 *                Проверяется ПЕРВЫМ: предоплаченный визит может иметь paid_full=1
 *                одновременно с attendance=-1 (депозит удержан, клиент не
 *                пришёл) — это всё равно отмена, а не повод начинать заботу.
 *   'enroll'   — визит состоялся (isVisitCompleted).
 *   'ignore'   — ожидание/промежуточный статус, ничего не делаем.
 *
 * payloadStatus — payload.status вебхука YClients ('create'|'update'|'delete').
 */
function classifyRecordEvent(data, payloadStatus) {
  if (!data) return 'ignore';
  if (payloadStatus === 'delete' || data.deleted === true || Number(data.attendance) === -1) {
    return 'unenroll';
  }
  if (isVisitCompleted(data)) return 'enroll';
  return 'ignore';
}

/**
 * Останавливает все активные enrollment'ы этой записи (любых программ салона)
 * и отменяет их ещё не отправленные касания. Вызывается на 'unenroll'.
 */
async function stopEnrollmentsForRecord(salon, ycRecordId, reason) {
  const rows = await db.any(
    `UPDATE care_enrollments
        SET status = 'stopped', status_reason = $3, updated_at = NOW()
      WHERE salon_id = $1 AND yclients_record_id = $2 AND status = 'active'
      RETURNING id`,
    [salon.id, ycRecordId, reason]
  );
  if (!rows.length) return;
  await db.query(
    `UPDATE care_touch_sends
        SET status = 'cancelled', decision_reason = $2
      WHERE enrollment_id = ANY($1::bigint[]) AND status = 'scheduled'`,
    [rows.map(r => r.id), `enrollment stopped: ${reason}`]
  );
  log.info(`record=${ycRecordId}: ${reason} — остановлены enrollments [${rows.map(r => r.id).join(',')}]`);
}

/**
 * Вызывается из routes/webhook.js на resource==='record' (любой status —
 * attendance проставляют апдейтом после визита, а отмена приходит отдельным
 * status='delete' или апдейтом с attendance=-1). Ошибки ловит вызывающий.
 */
async function handleRecordEvent(salon, payload) {
  const data = (payload && payload.data) || {};
  if (!data.id) return;

  const kind = classifyRecordEvent(data, payload && payload.status);
  if (kind === 'unenroll') {
    await stopEnrollmentsForRecord(salon, data.id, 'запись отменена/неявка');
    return;
  }
  if (kind !== 'enroll') return;

  const programs = await db.any(
    `SELECT p.*,
            COALESCE(json_agg(json_build_object(
              'id', t.id, 'delay_days', t.delay_days, 'send_time', t.send_time
            ) ORDER BY t.sort_order, t.id) FILTER (WHERE t.id IS NOT NULL), '[]') AS touches
       FROM care_programs p
       LEFT JOIN care_touches t ON t.program_id = p.id
      WHERE p.salon_id = $1 AND p.is_enabled = TRUE
      GROUP BY p.id`,
    [salon.id]
  );
  if (!programs.length) return;

  const serviceIds = (Array.isArray(data.services) ? data.services : [])
    .map(s => s && s.id).filter(v => v != null);
  // getServiceCategoryMap принимает ПОЛНЫЙ объект салона (нужны .id и
  // .yclients_company_id), не salonId — см. контракт в services/notifications.js.
  const catMap = await getServiceCategoryMap(salon).catch(() => new Map());
  const ctx = {
    staffId: data.staff && data.staff.id != null ? data.staff.id : null,
    serviceIds,
    categoryIds: [...new Set(serviceIds.map(id => catMap.get(String(id))).filter(Boolean))],
  };
  const matched = programs.filter(p => {
    try { return evaluateRule(p.conditions, ctx); }
    catch (e) { log.warn(`program #${p.id} evaluate failed: ${e.message}`); return false; }
  });
  if (!matched.length) {
    log.info(`record=${data.id}: ни одна программа не подошла (проверено ${programs.length})`);
    return;
  }

  const phone = normalizePhoneKey(data.client && data.client.phone);
  if (!phone) { log.info(`record=${data.id}: нет телефона клиента — забота невозможна`); return; }

  // Фолбэк по телефону: несинкнутый в clients клиент (yclients_client_id ещё
  // не проставлен строке) не должен проскакивать мимо ЧС — приоритет у
  // точного совпадения по yclients_client_id, если оно есть.
  const client = await db.oneOrNone(
    `SELECT id, name, is_blacklisted FROM clients
      WHERE salon_id = $1 AND (yclients_client_id = $2 OR phone = $3)
      ORDER BY (yclients_client_id = $2) DESC NULLS LAST
      LIMIT 1`,
    [salon.id, data.client && data.client.id, phone]
  );
  if (client && client.is_blacklisted) {
    log.info(`record=${data.id}: клиент в ЧС — не зачисляем`); return;
  }

  const visitAt = parseVisitAt(data.date);
  const servicesJson = JSON.stringify((Array.isArray(data.services) ? data.services : [])
    .map(s => ({ id: s && s.id, title: s && s.title })).filter(s => s.title));

  for (const p of matched) {
    // Более поздняя активная цепочка этой же программы уже существует — этот
    // (более ранний) визит не должен её глушить. Без даты визита сравнение
    // невозможно — пропускаем защиту (симметрично условию в supersede-блоке
    // ниже) и полагаемся на дедуп по record_id.
    if (visitAt) {
      const later = await db.oneOrNone(
        `SELECT id FROM care_enrollments
          WHERE salon_id = $1 AND program_id = $2 AND phone = $3
            AND status = 'active' AND visit_at > $4
          LIMIT 1`,
        [salon.id, p.id, phone, visitAt]
      );
      if (later) {
        log.info(`программа #${p.id}: пропуск — активная цепочка #${later.id} от более позднего визита`);
        continue;
      }
    }

    let enr = await db.oneOrNone(
      `INSERT INTO care_enrollments
         (salon_id, program_id, client_id, phone, yclients_record_id,
          visit_at, staff_yc_id, staff_name, services)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (program_id, yclients_record_id) DO NOTHING
       RETURNING id`,
      [salon.id, p.id, client ? client.id : null, phone, data.id,
       visitAt, (data.staff && data.staff.id) || null, (data.staff && data.staff.name) || null,
       servicesJson]
    );

    let isNewEnrollment = !!enr;
    if (!enr) {
      // Самолечение после частичного падения: тот же вебхук пришёл повторно
      // (ретрай YClients) уже ПОСЛЕ того, как строка enrollment была вставлена,
      // но процесс упал до того, как касания успели встать в очередь.
      // ON CONFLICT DO NOTHING отдаёт пустой RETURNING → без этой ветки
      // enrollment навсегда остаётся активным без единого касания. Дозагрузка
      // строки и повторный прогон планирования (идемпотентен через
      // ON CONFLICT (enrollment_id, touch_id) DO NOTHING) чинит это на
      // следующей же доставке.
      const existing = await db.oneOrNone(
        `SELECT id, status FROM care_enrollments
          WHERE program_id = $1 AND yclients_record_id = $2`,
        [p.id, data.id]
      );
      if (!existing) continue; // не должно случиться (UNIQUE только что сработал), но не падаем
      if (existing.status !== 'active') {
        log.info(`программа #${p.id}: enrollment #${existing.id} уже в статусе '${existing.status}' — повторный вебхук игнорируем`);
        continue;
      }
      enr = { id: existing.id };
    }

    if (isNewEnrollment && visitAt) {
      // Прежние активные прохождения этой программы у этого клиента устарели —
      // но ТОЛЬКО от визитов РАНЬШЕ этого. Правка старой записи (например,
      // коррекция оплаты) может перевыстрелить вебхук годы спустя: без условия
      // по visit_at она бы супersede'ила живую цепочку от актуального визита,
      // а её собственные касания — все в прошлом — закапали бы «как
      // самочувствие» задним числом (см. код-ревью).
      const old = await db.any(
        `UPDATE care_enrollments
            SET status = 'superseded', status_reason = 'новый визит перезапустил программу',
                updated_at = NOW()
          WHERE salon_id = $1 AND program_id = $2 AND phone = $3
            AND status = 'active' AND id <> $4
            AND (visit_at IS NULL OR visit_at < $5)
          RETURNING id`,
        [salon.id, p.id, phone, enr.id, visitAt]
      );
      if (old.length) {
        // enrollment_id — BIGINT (id из BIGSERIAL приходит из pg строкой) —
        // приводим массив к ::bigint[], а не ::int[], чтобы не зависеть от
        // того, что значения пока укладываются в int4.
        await db.query(
          `UPDATE care_touch_sends
              SET status = 'cancelled', decision_reason = 'enrollment superseded'
            WHERE enrollment_id = ANY($1::bigint[]) AND status = 'scheduled'`,
          [old.map(o => o.id)]
        );
        log.info(`программа #${p.id}: superseded=[${old.map(o => o.id)}]`);
      }
    }

    const touches = Array.isArray(p.touches) ? p.touches : JSON.parse(p.touches || '[]');
    let planned = 0;
    for (const t of touches) {
      const at = computeScheduledAt(visitAt || new Date(), t.delay_days, t.send_time);
      if (!at) {
        log.warn(`программа #${p.id} touch #${t.id}: computeScheduledAt вернул null (delay_days=${t.delay_days}, send_time=${t.send_time}) — касание пропущено`);
        continue;
      }
      await db.query(
        `INSERT INTO care_touch_sends (salon_id, enrollment_id, touch_id, scheduled_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (enrollment_id, touch_id) DO NOTHING`,
        [salon.id, enr.id, t.id, at]
      );
      planned++;
    }
    log.info(`программа #${p.id} «${p.title}»: enrollment #${enr.id} record=${data.id}${isNewEnrollment ? '' : ' (self-heal)'}, касаний спланировано=${planned}/${touches.length}`);
  }
}

module.exports = {
  isVisitCompleted,
  classifyRecordEvent,
  handleRecordEvent,
};
