'use strict';
// Data sources for journal READS. `live` asks YClients; `local` reads the
// mirror (`records`), the reference/schedule cache and the outbox overlay.
// Write paths (prepare/mutate, the outbox worker) always use `live`.
const { db } = require('../../db');
const config = require('../../config');
const yc = require('./yclients');
const m = require('./model');
const reference = require('./reference-cache');
const overlay = require('./overlay');
const logger = require('../../logger').createLogger('JournalSources');

const OPEN_OUTBOX_SQL = `SELECT * FROM journal_outbox WHERE salon_id=$1
  AND (status IN ('queued','running','failed') OR (status='done' AND updated_at > NOW()-interval '5 minutes'))
  ORDER BY id`;
const RECORDS_SQL = `SELECT raw_payload FROM records WHERE salon_id=$1
  AND visit_date BETWEEN $2::date AND $3::date AND status<>'deleted'`;

function live(salon) {
  const cid = salon.yclients_company_id;
  return {
    kind: 'live',
    staff: () => yc.list(salon, `/staff/${cid}`),
    services: () => yc.list(salon, `/company/${cid}/services/`),
    resources: () => yc.list(salon, `/resources/${cid}`),
    accounts: () => yc.list(salon, `/accounts/${cid}`),
    labels: () => yc.list(salon, `/labels/${cid}`),
    schedule: (staffId, date) => yc.list(salon, `/schedule/${cid}/${staffId}/${date}/${date}`),
    records: (from, to) => yc.records(salon, from, to),
  };
}

async function openOutbox(salonId) {
  return db.any(OPEN_OUTBOX_SQL, [salonId]);
}

function local(salon) {
  const fallback = live(salon);
  const ref = kind => async () => {
    const value = await reference.getReference(salon.id, kind);
    if (value == null) throw new m.JournalError(503, 'Справочники журнала ещё не загружены.', 'cache_cold');
    return value;
  };
  return {
    kind: 'local',
    staff: ref('staff'), services: ref('services'), resources: ref('resources'), accounts: ref('accounts'),
    // Labels are decoration: a cold cache is an empty list, not an error.
    labels: async () => (await reference.getReference(salon.id, 'labels')) || [],
    // Cache only (a miss is null, never a YClients call): for scans over many masters/days.
    cachedSchedule: (staffId, date) => reference.getSchedule(salon.id, staffId, date),
    async schedule(staffId, date) {
      const cached = await reference.getSchedule(salon.id, staffId, date);
      return cached || fallback.schedule(staffId, date);
    },
    async records(from, to) {
      const [rows, outbox] = await Promise.all([db.any(RECORDS_SQL, [salon.id, from, to]), openOutbox(salon.id)]);
      const list = rows.map(r => r.raw_payload).filter(r => r && !r.deleted);
      return overlay.applyOverlay(list, outbox);
    },
  };
}

let coldWarned = false;
async function forSalon(salon) {
  if (!config.JOURNAL_LOCAL_FIRST) return live(salon);
  const [staff, services] = await Promise.all([
    reference.getReference(salon.id, 'staff'), reference.getReference(salon.id, 'services'),
  ]);
  if (staff == null || services == null) {
    if (!coldWarned) { coldWarned = true; logger.warn(`salon ${salon.id}: journal reference cache cold, reading YClients live`); }
    return live(salon);
  }
  return local(salon);
}

module.exports = { live, local, forSalon, openOutbox, OPEN_OUTBOX_SQL, RECORDS_SQL };
