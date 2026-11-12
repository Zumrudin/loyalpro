'use strict';
// «Не уведомлять клиента» for a journal record (spec 2026-11-12 §4.3).
// The worker writes the flag BEFORE PUT /record (the webhook comes after).
// A new record has no id until POST /records answers and its create webhook
// may come first: it carries api_id = lp-outbox-<package id>, and the flag is
// read from that package's create step. Best effort: a failure = notify.
const { db } = require('../../db');
const logger = require('../../logger').createLogger('JournalPrefs');

const API_ID = /^lp-outbox-(\d{1,18})$/;
const OPT_OUT_REASON = 'journal_opt_out';
const apiIdFor = outboxId => `lp-outbox-${Number(outboxId)}`;

const UPSERT_SQL = `INSERT INTO journal_record_prefs(salon_id,yclients_record_id,notify_client,outbox_id,updated_at)
  VALUES($1,$2,$3,$4,NOW())
  ON CONFLICT (salon_id,yclients_record_id) DO UPDATE SET notify_client=EXCLUDED.notify_client, outbox_id=EXCLUDED.outbox_id, updated_at=NOW()`;
const GET_SQL = 'SELECT notify_client FROM journal_record_prefs WHERE salon_id=$1 AND yclients_record_id=$2';
const PACKAGE_SQL = 'SELECT steps FROM journal_outbox WHERE salon_id=$1 AND id=$2';

async function write(salonId, recordId, notifyClient, outboxId = null) {
  await db.query(UPSERT_SQL, [Number(salonId), Number(recordId), notifyClient !== false, outboxId == null ? null : Number(outboxId)]);
}
async function get(salonId, recordId) {
  return db.oneOrNone(GET_SQL, [Number(salonId), Number(recordId)]);
}
async function optOutForEvent(salonId, recordId, apiId) {
  try {
    const row = await get(salonId, recordId);
    if (row) return row.notify_client === false;
    const m = API_ID.exec(typeof apiId === 'string' ? apiId : '');
    if (!m) return false;
    const pkg = await db.oneOrNone(PACKAGE_SQL, [Number(salonId), Number(m[1])]);
    const create = (Array.isArray(pkg?.steps) ? pkg.steps : []).find(s => s && s.kind === 'create');
    return create?.params?.notifyClient === false;
  } catch (e) {
    logger.warn(`salon ${salonId} record ${recordId}: opt-out check failed (${e?.code || 'error'}), notifying as usual`);
    return false;
  }
}
module.exports = { write, get, optOutForEvent, apiIdFor, API_ID, OPT_OUT_REASON };
