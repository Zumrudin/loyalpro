'use strict';

const { db } = require('../../db');

// ── Состояние диалога агента (agent_dialogs). Тонкие обёртки над SQL. ──

// Гарантированно вернуть строку диалога (создать при первом обращении).
async function getOrCreate(salonId, dialogKey) {
  return db.one(
    `INSERT INTO agent_dialogs (salon_id, dialog_key)
     VALUES ($1, $2)
     ON CONFLICT (salon_id, dialog_key)
       DO UPDATE SET last_activity = now()
     RETURNING id, salon_id, dialog_key, status, collected, watermark_ts, dirty, escalated_reason`,
    [salonId, dialogKey]);
}

async function get(salonId, dialogKey) {
  return db.oneOrNone(
    `SELECT id, status, collected, watermark_ts, dirty, escalated_reason
       FROM agent_dialogs WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey]);
}

// Зафиксировать прочитанную водяную метку и сбросить dirty после успешного хода.
async function setWatermark(salonId, dialogKey, watermark) {
  await db.query(
    `UPDATE agent_dialogs
        SET watermark_ts = $3, dirty = false, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, watermark || 0]);
}

// Сменить статус (bot ↔ escalated ↔ closed). reason — для escalated.
async function setStatus(salonId, dialogKey, status, reason = null) {
  await db.query(
    `UPDATE agent_dialogs
        SET status = $3, escalated_reason = $4, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, status, reason]);
}

module.exports = { getOrCreate, get, setWatermark, setStatus };
