'use strict';
// Зачисление в программы заботы. Триггер — вебхук записи, у которой визит
// СОСТОЯЛСЯ: attendance=1 ИЛИ paid_full=1 (именно ИЛИ — кэшбэчный критерий
// «оплачено деньгами» тут не годится: визит с оплатой бонусами тоже
// заслуживает заботы). Дедуп повторных доставок — UNIQUE (program_id, record_id).
//
// Повторный подходящий визит (курсовой клиент): прежний активный enrollment
// той же программы → 'superseded', его будущие касания → 'cancelled', цепочка
// стартует заново от нового визита.

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
 * Вызывается из routes/webhook.js на resource==='record' (любой status —
 * attendance проставляют апдейтом после визита). Ошибки ловит вызывающий.
 */
async function handleRecordEvent(salon, payload) {
  const data = (payload && payload.data) || {};
  if (!data.id || !isVisitCompleted(data)) return;

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
  if (!matched.length) return;

  const phone = normalizePhoneKey(data.client && data.client.phone);
  if (!phone) { log.info(`record=${data.id}: нет телефона клиента — забота невозможна`); return; }

  const client = await db.oneOrNone(
    `SELECT id, name, is_blacklisted FROM clients
      WHERE salon_id = $1 AND yclients_client_id = $2`,
    [salon.id, data.client && data.client.id]
  );
  if (client && client.is_blacklisted) {
    log.info(`record=${data.id}: клиент в ЧС — не зачисляем`); return;
  }

  const visitAt = parseVisitAt(data.date);
  const servicesJson = JSON.stringify((Array.isArray(data.services) ? data.services : [])
    .map(s => ({ id: s && s.id, title: s && s.title })).filter(s => s.title));

  for (const p of matched) {
    const enr = await db.oneOrNone(
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
    if (!enr) continue; // дубль вебхука / уже зачислен этим визитом

    // Прежние активные прохождения этой программы у этого клиента — устарели.
    const old = await db.any(
      `UPDATE care_enrollments
          SET status = 'superseded', status_reason = 'новый визит перезапустил программу',
              updated_at = NOW()
        WHERE salon_id = $1 AND program_id = $2 AND phone = $3
          AND status = 'active' AND id <> $4
        RETURNING id`,
      [salon.id, p.id, phone, enr.id]
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
    }

    const touches = Array.isArray(p.touches) ? p.touches : JSON.parse(p.touches || '[]');
    for (const t of touches) {
      const at = computeScheduledAt(visitAt || new Date(), t.delay_days, t.send_time);
      if (!at) continue;
      await db.query(
        `INSERT INTO care_touch_sends (salon_id, enrollment_id, touch_id, scheduled_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (enrollment_id, touch_id) DO NOTHING`,
        [salon.id, enr.id, t.id, at]
      );
    }
    log.info(`программа #${p.id} «${p.title}»: enrollment #${enr.id} record=${data.id}, касаний=${touches.length}${old.length ? `, superseded=[${old.map(o => o.id)}]` : ''}`);
  }
}

module.exports = { isVisitCompleted, handleRecordEvent };
