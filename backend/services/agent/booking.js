'use strict';

const crypto = require('crypto');
const { db } = require('../../db');
const { ycCreateRecord } = require('../yclients-booking');

// ── Исполнитель создания записи. Единственное необратимое действие агента. ──
// Под pg_advisory_xact_lock(salon, dialog) + идемпотентный ключ
// (dialog+service+datetime), чтобы дубль-вебхук/гонка не создали вторую бронь.
// Спека: docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md (гейт create_booking).

// Стабильный ключ идемпотентности одной брони.
function buildIdempotencyKey(dialogKey, serviceYcId, datetime) {
  return crypto.createHash('sha256')
    .update(`${dialogKey}|${serviceYcId}|${datetime}`, 'utf8')
    .digest('hex');
}

// 32-битный ключ для advisory-lock из строки (диалога).
function lockKey(str) {
  const h = crypto.createHash('sha256').update(String(str), 'utf8').digest();
  return h.readInt32BE(0);
}

async function createBookingRecord(salonId, draft) {
  const {
    dialogKey, staffYcId, serviceYcId, datetime, seanceLength,
    clientPhone, clientName, comment,
  } = draft;
  const idem = buildIdempotencyKey(dialogKey, serviceYcId, datetime);

  // Сериализуем обработку диалога на время создания записи.
  await db.query(`SELECT pg_advisory_xact_lock($1, $2)`, [salonId, lockKey(dialogKey)]);

  // Уже создавали эту бронь? (идемпотентность против дубль-вебхука/ретрая)
  const prior = await db.oneOrNone(
    `SELECT id, payload FROM agent_events
      WHERE salon_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [salonId, idem]);
  if (prior) {
    return { created: false, duplicate: true, record_id: prior.payload && prior.payload.record_id };
  }

  const salon = await db.one(`SELECT * FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) {
    return { created: false, error: 'YClients не подключён для салона.' };
  }

  let record;
  try {
    record = await ycCreateRecord(salon, {
      staffYcId, serviceYcIds: [serviceYcId], datetime, seanceLength,
      clientPhone, clientName, comment,
    });
  } catch (e) {
    return { created: false, error: e.message };
  }

  const recordId = record && record.id;
  // Помечаем успешную бронь идемпотентным ключом — только после успеха YClients.
  await db.query(
    `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload, idempotency_key)
     VALUES ($1,$2,'booking_created','create_booking',$3,$4)
     ON CONFLICT (salon_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [salonId, dialogKey, JSON.stringify({ record_id: recordId, staffYcId, serviceYcId, datetime }), idem]);

  return { created: true, record_id: recordId };
}

module.exports = { buildIdempotencyKey, lockKey, createBookingRecord };
