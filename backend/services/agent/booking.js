'use strict';

const crypto = require('crypto');
const { pool } = require('../../db');
const { ycCreateRecord } = require('../yclients-booking');
const { ycGetRecord } = require('../yclients-records');
const { isRecordAlive } = require('./record-liveness');
const { createLogger } = require('../../logger');

const logger = createLogger('AgentBooking');

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

// Best-effort лог НЕУДАЧНОЙ попытки записи. Без него провал create_booking не
// оставляет следа — инцидент 2026-07-21: агент написал «запись оформлена», а
// записи нет и в agent_events пусто. Пишем отдельным соединением (транзакция
// брони уже откатана) и глушим ошибки — лог не должен ломать ответ агенту.
async function logBookingFailure(salonId, draft, reason) {
  try {
    await pool.query(
      `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload)
       VALUES ($1,$2,'booking_failed','create_booking',$3)`,
      [salonId, draft.dialogKey, JSON.stringify({
        reason: String(reason || '').slice(0, 500),
        staffYcId: draft.staffYcId, serviceYcId: draft.serviceYcId,
        datetime: draft.datetime, clientPhone: draft.clientPhone,
      })]);
  } catch (_) { /* лог не должен ломать ответ агенту */ }
}

// Жива ли ещё бронь, помеченная идемпотентным ключом.
//   true  — существует, ключ работает как раньше (дубль-вебхук/ретрай);
//   false — удалена или отменена, ключ протух;
//   null  — выяснить не удалось (нет record_id в старой строке, сбой YClients).
//
// ЗАЧЕМ. Ключ (диалог+услуга+мастер+время+телефон) жил вечно и о судьбе записи
// ничего не знал. Инцидент 2026-08-04: тестовую запись удалили в YClients, и
// повтор записи на тот же слот вернул бы duplicate:true с МЁРТВЫМ record_id —
// Мила отчиталась бы «вы записаны», а записи бы не появилось. Это же ломало
// штатный «запись отменили, надо вернуть в работу»: отмена и перенос ключ не гасят,
// а правку в CRM руками мы не видим вовсе.
//
// FAIL-SAFE в неизвестность: при сбое сети возвращаем null → вызывающий код
// оставляет прежнее поведение (дубликат). Ошибиться в сторону «уже записан»
// дешевле, чем создать пациенту вторую бронь на то же время.
async function priorBookingAlive(salon, recordId) {
  if (!recordId) return null;
  try {
    return isRecordAlive(await ycGetRecord(salon, recordId));
  } catch (e) {
    // Удалённую запись YClients отдаёт телом с deleted:true, а не 404 (см.
    // record-liveness.js) — но если 404 всё-таки пришёл, он однозначен.
    if (e && e.status === 404) return false;
    logger.warn(`не проверить запись ${recordId} (${e.message}) — считаем ключ действующим`);
    return null;
  }
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

    const salon = (await client.query(`SELECT * FROM salons WHERE id=$1`, [salonId])).rows[0];
    if (!salon || !salon.yclients_company_id) {
      await client.query('COMMIT');
      return { created: false, error: 'YClients не подключён для салона.' };
    }

    // Уже создавали эту бронь? (идемпотентность против дубль-вебхука/ретрая)
    const prior = (await client.query(
      `SELECT id, payload FROM agent_events WHERE salon_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [salonId, idem])).rows[0];
    if (prior) {
      const priorRecordId = prior.payload && prior.payload.record_id;
      // Ключ действует, только пока жива помеченная им запись. Мёртвая (удалили
      // в CRM, отменили) означает, что пациента надо записать ЗАНОВО, а не
      // отчитаться о несуществующей брони.
      const alive = await priorBookingAlive(salon, priorRecordId);
      if (alive !== false) {
        await client.query('COMMIT');
        return { created: false, duplicate: true, record_id: priorRecordId };
      }
      // Строку журнала не удаляем — форензика ценнее: гасим только ключ, и
      // частичный UNIQUE (salon_id, idempotency_key) снова свободен для этого слота.
      await client.query(`UPDATE agent_events SET idempotency_key = NULL WHERE id = $1`, [prior.id]);
      logger.info(`диалог ${dialogKey}: запись ${priorRecordId} удалена/отменена в YClients — ключ брони погашен, записываю заново`);
    }

    let record;
    try {
      record = await ycCreateRecord(salon, {
        staffYcId, serviceYcIds: [serviceYcId], datetime, seanceLength,
        clientPhone, clientName, comment,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      await logBookingFailure(salonId, draft, e.message);
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
    await logBookingFailure(salonId, draft, e.message);
    return { created: false, error: e.message };
  } finally {
    client.release();
  }
}

// Сколько провалов записи (booking_failed) уже было в этом диалоге ПОСЛЕ последнего
// успеха (booking_created) — чтобы ограничить «переигровку» после провала одной
// попыткой на серию. Текущий провал уже залогирован logBookingFailure, поэтому
// значение >1 означает наличие ПРЕДЫДУЩЕГО провала → пора переводить на человека,
// а не давать модели бесконечно предлагать неудачные слоты. Fail-open (0 при сбое):
// сбой лога не должен запирать легитимную переигровку.
async function countBookingFailuresSinceSuccess(salonId, dialogKey) {
  try {
    const row = (await pool.query(
      `SELECT count(*)::int AS n FROM agent_events
        WHERE salon_id = $1 AND dialog_key = $2 AND kind = 'booking_failed'
          AND created_at > COALESCE(
            (SELECT max(created_at) FROM agent_events
              WHERE salon_id = $1 AND dialog_key = $2 AND kind = 'booking_created'),
            'epoch'::timestamptz)`,
      [salonId, dialogKey])).rows[0];
    return (row && row.n) || 0;
  } catch (_) { return 0; }
}

module.exports = { buildIdempotencyKey, lockKey, createBookingRecord, countBookingFailuresSinceSuccess };
