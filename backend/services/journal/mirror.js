'use strict';
const { db } = require('../../db');
const yc = require('./yclients');
const loyalty = require('../loyalty');
const logger = require('../../logger').createLogger('JournalMirror');

const NEAR_DAYS = 14;
const FAR_DAYS = 120;
const SRC = 'journal_mirror';

const shiftDate = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const todayMsk = (now = new Date()) => now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const windowFor = (kind, now) => {
  const t = todayMsk(now);
  return { from: shiftDate(t, -1), to: shiftDate(t, kind === 'far' ? FAR_DAYS : NEAR_DAYS) };
};

// YClients last_change_date ("2026-11-08T21:34:38+0300") → ms; unknown → null.
const changedAt = v => { const ms = Date.parse(String(v || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); return Number.isFinite(ms) ? ms : null; };

const markError = (salonId, code) => db.query(
  `INSERT INTO journal_mirror_state(salon_id,last_error,updated_at) VALUES($1,$2,NOW())
   ON CONFLICT (salon_id) DO UPDATE SET last_error=$2, updated_at=NOW()`, [salonId, code]);

async function syncWindow(salon, from, to) {
  let list;
  try {
    list = await yc.records(salon, from, to);
  } catch (e) {
    try { await markError(salon.id, 'records_unavailable'); } catch (_) { /* best effort */ }
    throw e;
  }
  let upserted = 0, deleted = 0, moved = 0, unchanged = 0;
  const ids = new Set();
  // A webhook may already have stored a newer version: never overwrite it with
  // an older (or the same) page snapshot — and skip the write when unchanged.
  const stored = new Map((await db.any(
    `SELECT yclients_record_id::text AS id, raw_payload->>'last_change_date' AS changed FROM records
      WHERE salon_id=$1 AND yclients_record_id = ANY($2::bigint[])`, [salon.id, list.map(r => Number(r.id))]))
    .map(x => [x.id, changedAt(x.changed)]));
  for (const r of list) {
    ids.add(String(r.id));
    const known = stored.get(String(r.id)), incoming = changedAt(r.last_change_date);
    if (known != null && incoming != null && known >= incoming) { unchanged++; continue; }
    let dbClientId = null;
    if (r.client && r.client.id) {
      const c = await db.oneOrNone('SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salon.id, r.client.id]);
      dbClientId = (c && c.id) || null;
    }
    await loyalty.upsertRecordFromYc(salon.id, r, dbClientId, SRC);
    upserted++;
  }
  const local = await db.any(
    `SELECT yclients_record_id, raw_payload FROM records
      WHERE salon_id=$1 AND visit_date BETWEEN $2::date AND $3::date AND status<>'deleted'`, [salon.id, from, to]);
  for (const row of local) {
    if (ids.has(String(row.yclients_record_id))) continue;
    try {
      const rec = await yc.getRecord(salon, Number(row.yclients_record_id));
      await loyalty.upsertRecordFromYc(salon.id, rec, null, SRC);
      if (rec && rec.deleted) deleted++; else moved++;
    } catch (e) {
      if (e && e.status === 404) {
        await loyalty.upsertRecordFromYc(salon.id, { ...(row.raw_payload || {}), deleted: true }, null, SRC);
        deleted++;
      } else {
        logger.warn(`salon ${salon.id}: record check failed (${(e && (e.status || e.code)) || 'error'}), row left as is`);
      }
    }
  }
  await db.query(
    `INSERT INTO journal_mirror_state(salon_id,last_ok_at,last_error,updated_at) VALUES($1,NOW(),NULL,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET last_ok_at=NOW(), last_error=NULL, updated_at=NOW()`, [salon.id]);
  logger.info(`salon ${salon.id}: upserted ${upserted}, unchanged ${unchanged}, deleted ${deleted}, moved ${moved}`);
  return { upserted, unchanged, deleted, moved };
}

async function freshness(salonId) {
  const row = await db.oneOrNone('SELECT last_ok_at FROM journal_mirror_state WHERE salon_id=$1', [salonId]);
  return { mirrorOkAt: row && row.last_ok_at ? new Date(row.last_ok_at).toISOString() : null };
}

module.exports = { NEAR_DAYS, FAR_DAYS, todayMsk, windowFor, syncWindow, freshness, shiftDate };
