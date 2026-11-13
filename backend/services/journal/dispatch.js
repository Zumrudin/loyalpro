'use strict';
// Manual dispatch to YClients (10.11.2026, decision of the salon): journal
// changes are stored locally and wait; the journal's «Отправить в YClients»
// releases the packages of the records whose visit falls into the chosen
// period, and only released packages are leased by the outbox worker.
//
// A record is released WHOLE: all its waiting packages (the create and every
// later change) go together, otherwise an earlier unsent change would block a
// later one forever (the worker keeps packages of a record strictly in order).
const crypto = require('crypto');
const { db } = require('../../db');
const m = require('./model');
const finOps = require('../finance-ops');

const MAX_DAYS = 366;

// Every waiting package with its record group and the visit dates it touches:
// a create's date, a move's new date, the mirrored visit date, the create
// date of the new record a change belongs to.
const WAITING_CTE = `WITH pkg AS (
  SELECT o.id,
    COALESCE('r' || o.yclients_record_id::text, 'c' || COALESCE(o.create_outbox_id, o.id)::text) AS grp,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN o.overlay->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (o.overlay->>'date')::date END,
      CASE WHEN o.overlay->'patch'->>'datetime' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN left(o.overlay->'patch'->>'datetime', 10)::date END,
      r.visit_date,
      CASE WHEN c.overlay->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (c.overlay->>'date')::date END
    ], NULL) AS dates
  FROM journal_outbox o
  LEFT JOIN records r ON r.salon_id=o.salon_id AND r.yclients_record_id=o.yclients_record_id
  LEFT JOIN journal_outbox c ON c.salon_id=o.salon_id AND c.id=o.create_outbox_id
  WHERE o.salon_id=$1 AND o.status='queued' AND o.released_at IS NULL
)`;
const PERIOD_SQL = `${WAITING_CTE},
hit AS (SELECT DISTINCT grp FROM pkg WHERE EXISTS (SELECT 1 FROM unnest(dates) d WHERE d BETWEEN $2::date AND $3::date))
SELECT p.id, p.grp FROM pkg p JOIN hit USING (grp) ORDER BY p.id`;
const SUMMARY_SQL = `${WAITING_CTE}
SELECT count(*)::int AS packages, count(DISTINCT grp)::int AS records,
  to_char(min(d), 'YYYY-MM-DD') AS "from", to_char(max(d), 'YYYY-MM-DD') AS "to"
FROM pkg LEFT JOIN LATERAL unnest(pkg.dates) d ON TRUE`;
const RELEASE_SQL = `UPDATE journal_outbox SET released_at=NOW(), release_id=$2, next_attempt_at=NOW(), updated_at=NOW()
  WHERE salon_id=$1 AND id = ANY($3::bigint[]) AND status='queued' AND released_at IS NULL RETURNING id`;
const PROGRESS_SQL = `SELECT status, count(*)::int AS n FROM journal_outbox WHERE salon_id=$1 AND release_id=$2 GROUP BY status`;
const FAILED_SQL = `SELECT id, yclients_record_id, create_outbox_id, error_text, overlay
  FROM journal_outbox WHERE salon_id=$1 AND release_id=$2 AND status='failed' ORDER BY id LIMIT 20`;

function period(input) {
  const from = m.dateKey(input?.from), to = m.dateKey(input?.to);
  if (from > to) m.fail('Начало периода позже конца.');
  const days = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000 + 1;
  if (days > MAX_DAYS) m.fail(`Период не больше ${MAX_DAYS} дней.`);
  return { from, to };
}

async function waiting(salonId, p) {
  const rows = await db.any(PERIOD_SQL, [salonId, p.from, p.to]);
  return { ids: rows.map(r => Number(r.id)), records: new Set(rows.map(r => r.grp)).size };
}

async function summary(salonId) {
  const row = await db.oneOrNone(SUMMARY_SQL, [salonId]);
  return { packages: row?.packages || 0, records: row?.records || 0, from: row?.from || null, to: row?.to || null };
}

async function preview(salonId, input) {
  const p = period(input);
  const { ids, records } = await waiting(salonId, p);
  return { ...p, packages: ids.length, records };
}

async function release(salonId, input) {
  const p = period(input);
  const { ids, records } = await waiting(salonId, p);
  if (!ids.length) return { ...p, releaseId: null, packages: 0, records: 0 };
  const releaseId = crypto.randomUUID();
  const done = await db.any(RELEASE_SQL, [salonId, releaseId, ids]);
  await finOps.safely('journal-release', () => finOps.markOutbox(salonId, done.map(r => r.id), 'sending'));
  return { ...p, releaseId, packages: done.length, records };
}

async function progress(salonId, releaseId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(releaseId || '')) m.fail('Некорректный номер отправки.');
  const rows = await db.any(PROGRESS_SQL, [salonId, releaseId]);
  const out = { releaseId, total: 0, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of rows) { if (r.status in out) out[r.status] = r.n; out.total += r.n; }
  out.finished = out.queued === 0 && out.running === 0;
  out.failures = out.failed ? (await db.any(FAILED_SQL, [salonId, releaseId])).map(r => ({
    outboxId: Number(r.id),
    recordId: r.yclients_record_id != null ? Number(r.yclients_record_id) : -Number(r.create_outbox_id || r.id),
    date: r.overlay?.date || String(r.overlay?.patch?.datetime || '').slice(0, 10) || null,
    clientName: String(r.overlay?.client?.name || ''),
    errorText: r.error_text || null,
  })) : [];
  return out;
}

module.exports = { period, summary, preview, release, progress, PERIOD_SQL, SUMMARY_SQL, RELEASE_SQL, MAX_DAYS };
