'use strict';
// «Не уведомлять клиента» for a journal record (spec 2026-11-12 §4.3).
// The worker writes the flag BEFORE PUT /record (the webhook comes after).
// A new record has no id until POST /records answers and its create webhook
// may come first: it carries api_id = the bare package id (YClients keeps only
// a number; live run 13.11.2026), and the flag is read from that package's
// create step — only if the package is ours for this record (has a create step,
// and yclients_record_id is NULL or equal): other integrations/online booking
// may send numeric api_id too. Best effort: a failure = notify.
const { db } = require('../../db');
const logger = require('../../logger').createLogger('JournalPrefs');

const API_ID = /^\d{1,15}$/;
const OPT_OUT_REASON = 'journal_opt_out';
const apiIdFor = outboxId => String(Number(outboxId));

const UPSERT_SQL = `INSERT INTO journal_record_prefs(salon_id,yclients_record_id,notify_client,outbox_id,updated_at)
  VALUES($1,$2,$3,$4,NOW())
  ON CONFLICT (salon_id,yclients_record_id) DO UPDATE SET notify_client=EXCLUDED.notify_client, outbox_id=EXCLUDED.outbox_id, updated_at=NOW()`;
const GET_SQL = 'SELECT notify_client FROM journal_record_prefs WHERE salon_id=$1 AND yclients_record_id=$2';
const PACKAGE_SQL = 'SELECT steps, yclients_record_id FROM journal_outbox WHERE salon_id=$1 AND id=$2';

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
    const raw = typeof apiId === 'string' ? apiId : '';
    if (!API_ID.test(raw) || Number(raw) < 1) return false;
    const pkg = await db.oneOrNone(PACKAGE_SQL, [Number(salonId), Number(raw)]);
    if (!pkg) return false;
    if (pkg.yclients_record_id != null && Number(pkg.yclients_record_id) !== Number(recordId)) return false;
    const create = (Array.isArray(pkg.steps) ? pkg.steps : []).find(s => s && s.kind === 'create');
    return create?.params?.notifyClient === false;
  } catch (e) {
    logger.warn(`salon ${salonId} record ${recordId}: opt-out check failed (${e?.code || 'error'}), notifying as usual`);
    return false;
  }
}
module.exports = { write, get, optOutForEvent, apiIdFor, API_ID, OPT_OUT_REASON };
