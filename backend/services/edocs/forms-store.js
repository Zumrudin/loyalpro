'use strict';
// SQL анкет пациента (edoc_patient_forms). Запросы администратора ограничены salon_id; публичные
// ищут анкету по sha256 токена и дальше работают с её salon_id. Переходы статуса — условными
// UPDATE: одна анкета принимается один раз, отозванная/устаревшая не оживает.
const { db, withTransaction } = require('../../db');

const COLS = `id, salon_id, client_id, record_id, token_enc, status, fields, kinds, send_docs, sender_user_id, source, created_by,
  expires_at, delivered_via, delivered_at, opened_at, submitted_at, submit_attempts, recognize_count, package_id, last_error, created_at`;

/** Новая анкета; прежние активные анкеты пациента отзываются в той же транзакции. @returns {string[]} id отозванных */
async function insertForm(f) {
  return withTransaction(async (c) => {
    const revoked = (await c.query(
      `UPDATE edoc_patient_forms SET status='revoked', updated_at=NOW() WHERE salon_id=$1 AND client_id=$2 AND status='active' RETURNING id`,
      [f.salon_id, f.client_id],
    )).rows.map((r) => r.id);
    await c.query(
      `INSERT INTO edoc_patient_forms (id, salon_id, client_id, record_id, token_hash, token_enc, fields, kinds, send_docs,
         sender_user_id, source, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)`,
      [f.id, f.salon_id, f.client_id, f.record_id || null, f.token_hash, f.token_enc, JSON.stringify(f.fields || []),
        JSON.stringify(f.kinds || []), !!f.send_docs, f.sender_user_id || null, f.source || 'manual', f.created_by || null, f.expires_at],
    );
    return revoked;
  });
}
async function getForm(salonId, id) {
  return db.oneOrNone(`SELECT ${COLS} FROM edoc_patient_forms WHERE salon_id=$1 AND id=$2`, [salonId, id]);
}
async function getFormByHash(tokenHash) {
  return db.oneOrNone(`SELECT ${COLS} FROM edoc_patient_forms WHERE token_hash=$1`, [tokenHash]);
}
async function setDelivered(id, via) {
  await db.query('UPDATE edoc_patient_forms SET delivered_via=$2, delivered_at=NOW(), updated_at=NOW() WHERE id=$1', [id, via]);
}
/** Первое открытие пациентом. true — это было первое. */
async function markOpened(id) {
  const r = await db.oneOrNone(`UPDATE edoc_patient_forms SET opened_at=NOW(), updated_at=NOW() WHERE id=$1 AND opened_at IS NULL RETURNING id`, [id]);
  return !!r;
}
/** Счётчик попыток отправки анкеты; возвращает новое значение. */
async function incAttempts(id) {
  const r = await db.oneOrNone(`UPDATE edoc_patient_forms SET submit_attempts=submit_attempts+1, updated_at=NOW() WHERE id=$1 RETURNING submit_attempts`, [id]);
  return r ? Number(r.submit_attempts) : 0;
}
/** Ещё одно распознавание, если лимит не исчерпан. true — можно распознавать. */
async function takeRecognize(id, limit) {
  const r = await db.oneOrNone(
    `UPDATE edoc_patient_forms SET recognize_count=recognize_count+1, updated_at=NOW()
     WHERE id=$1 AND status='active' AND recognize_count < $2 RETURNING recognize_count`, [id, limit]);
  return !!r;
}
/** Анкета принята (один раз): active → submitted. true — приняли мы. */
async function markSubmitted(id, consent) {
  const r = await db.oneOrNone(
    `UPDATE edoc_patient_forms SET status='submitted', submitted_at=NOW(), consent=$2::jsonb, updated_at=NOW()
     WHERE id=$1 AND status='active' AND expires_at > NOW() RETURNING id`, [id, JSON.stringify(consent || {})]);
  return !!r;
}
/** Данные не сохранились после приёма — вернуть анкету пациенту (повторит отправку). */
async function reopen(id) {
  await db.query(`UPDATE edoc_patient_forms SET status='active', submitted_at=NULL, consent=NULL, updated_at=NOW() WHERE id=$1 AND status='submitted'`, [id]);
}
async function setResult(id, { packageId = null, error = null }) {
  await db.query('UPDATE edoc_patient_forms SET package_id=COALESCE($2, package_id), last_error=$3, updated_at=NOW() WHERE id=$1',
    [id, packageId, error ? String(error).slice(0, 500) : null]);
}
async function revoke(salonId, id) {
  const r = await db.oneOrNone(`UPDATE edoc_patient_forms SET status='revoked', updated_at=NOW() WHERE salon_id=$1 AND id=$2 AND status='active' RETURNING id, client_id`, [salonId, id]);
  return r || null;
}
/** Устаревшие активные анкеты → expired (крон). @returns [{ id, salon_id, client_id }] */
async function expireDue() {
  return db.any(`UPDATE edoc_patient_forms SET status='expired', updated_at=NOW() WHERE status='active' AND expires_at <= NOW() RETURNING id, salon_id, client_id`);
}
/** Ближайший будущий визит пациента (для приветствия и текста сообщения). */
async function nextVisit(salonId, clientId) {
  return db.oneOrNone(
    `SELECT id, visit_datetime FROM records
     WHERE salon_id=$1 AND client_id=$2 AND visit_datetime > NOW() AND COALESCE(status, '') NOT IN ('deleted', 'no_show')
       AND NOT COALESCE((raw_payload->>'deleted')::boolean, false)
     ORDER BY visit_datetime LIMIT 1`, [salonId, clientId]);
}
async function recordVisit(salonId, recordId) {
  return db.oneOrNone('SELECT id, visit_datetime FROM records WHERE salon_id=$1 AND id=$2', [salonId, recordId]);
}
async function salonName(salonId) {
  const r = await db.oneOrNone('SELECT name FROM salons WHERE id=$1', [salonId]);
  return (r && r.name) || '';
}

module.exports = {
  insertForm, getForm, getFormByHash, setDelivered, markOpened, incAttempts, takeRecognize, markSubmitted, reopen, setResult, revoke,
  expireDue, nextVisit, recordVisit, salonName,
};
