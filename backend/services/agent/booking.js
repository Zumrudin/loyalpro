'use strict';

const crypto = require('crypto');
const { pool } = require('../../db');
const { ycCreateRecord } = require('../yclients-booking');

// ── Исполнитель создания записи. Единственное необратимое действие агента. ──
// Всё под ОДНИМ соединением в транзакции: pg_advisory_xact_lock(salon, dialog)
// держится до COMMIT, поэтому конкурентные вызовы по одному диалогу
// сериализуются — дубль-вебхук/гонка не создадут вторую бронь. Идемпотентный
// ключ (dialog+service+datetime) — второй барьер на уровне БД.
// Спека: docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md (гейт create_booking).

// Стабильный ключ идемпотентности одной брони.
// Мастер и телефон входят в ключ намеренно: параллельная запись двух гостей
// идёт из ОДНОГО диалога, и без них вторая бронь (та же услуга, то же время,
// другой мастер/гость) схлопнулась бы в «дубликат» — человек остался бы
// незаписанным, а агент отчитался бы об успехе. Ретрай одной и той же брони
// по-прежнему даёт тот же ключ, так что защита от дубль-вебхука сохраняется.
function buildIdempotencyKey(draft = {}) {
  const { dialogKey, serviceYcId, staffYcId, datetime, clientPhone } = draft;
  return crypto.createHash('sha256')
    .update(`${dialogKey}|${serviceYcId}|${staffYcId}|${datetime}|${clientPhone || ''}`, 'utf8')
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
  const idem = buildIdempotencyKey(draft);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Лок на диалог держится до конца транзакции (COMMIT/ROLLBACK).
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [salonId, lockKey(dialogKey)]);

    // Уже создавали эту бронь? (идемпотентность против дубль-вебхука/ретрая)
    const prior = (await client.query(
      `SELECT id, payload FROM agent_events WHERE salon_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [salonId, idem])).rows[0];
    if (prior) {
      await client.query('COMMIT');
      return { created: false, duplicate: true, record_id: prior.payload && prior.payload.record_id };
    }

    const salon = (await client.query(`SELECT * FROM salons WHERE id=$1`, [salonId])).rows[0];
    if (!salon || !salon.yclients_company_id) {
      await client.query('COMMIT');
      return { created: false, error: 'YClients не подключён для салона.' };
    }

    let record;
    try {
      record = await ycCreateRecord(salon, {
        staffYcId, serviceYcIds: [serviceYcId], datetime, seanceLength,
        clientPhone, clientName, comment,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      return { created: false, error: e.message };
    }

    const recordId = record && record.id;
    // Помечаем успешную бронь идемпотентным ключом — только после успеха YClients.
    await client.query(
      `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload, idempotency_key)
       VALUES ($1,$2,'booking_created','create_booking',$3,$4)
       ON CONFLICT (salon_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [salonId, dialogKey, JSON.stringify({ record_id: recordId, staffYcId, serviceYcId, datetime }), idem]);
    await client.query('COMMIT');
    return { created: true, record_id: recordId };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* соединение уже мертво */ }
    return { created: false, error: e.message };
  } finally {
    client.release();
  }
}

module.exports = { buildIdempotencyKey, lockKey, createBookingRecord };
