'use strict';
// Read-only journal day summary. Money comes from finance_operations; booking
// value and unique clients come from the local records mirror with open journal
// packages overlaid. No YClients fallback is used here.
const { db } = require('../../db');
const m = require('./model');
const overlay = require('./overlay');

const SUMMARY_SQL = `WITH open_outbox AS (
  SELECT * FROM journal_outbox WHERE salon_id=$1
    AND (status IN ('queued','running','failed')
      OR (status='done' AND updated_at > NOW()-interval '5 minutes'))
), finance AS (
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE status='confirmed' AND method IN ('cash','card','other')), 0) AS total,
    COALESCE(SUM(amount) FILTER (WHERE status='confirmed' AND method='cash'), 0) AS cash,
    COALESCE(SUM(amount) FILTER (WHERE status='confirmed' AND method='card'), 0) AS cashless_amount,
    COALESCE(SUM(amount) FILTER (WHERE status='confirmed' AND method='other'), 0) AS other_amount,
    COALESCE(SUM(amount) FILTER (WHERE status='confirmed' AND kind='goods_sale' AND method<>'bonus'), 0) AS goods_amount,
    COALESCE(-SUM(amount) FILTER (WHERE status='confirmed' AND method='bonus'
      AND kind IN ('bonus_redemption','payment_reversal')), 0) AS loyalty_amount,
    COUNT(*) FILTER (WHERE status IN ('queued','sending'))::int AS pending_count
  FROM finance_operations WHERE salon_id=$1 AND op_date=$2::date
), record_rows AS (
  SELECT COALESCE(jsonb_agg(raw_payload ORDER BY yclients_record_id)
    FILTER (WHERE raw_payload IS NOT NULL), '[]'::jsonb) AS records
  FROM records r WHERE salon_id=$1
    AND (visit_date BETWEEN $2::date - 1 AND $2::date + 1
      OR yclients_record_id IN (SELECT yclients_record_id FROM open_outbox WHERE yclients_record_id IS NOT NULL))
    AND COALESCE(status,'')<>'deleted'
), outbox_rows AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY id), '[]'::jsonb) AS outbox
  FROM open_outbox o
)
SELECT finance.*, record_rows.records, outbox_rows.outbox
FROM finance CROSS JOIN record_rows CROSS JOIN outbox_rows`;

// Convert at every addition boundary: 0.1 + 0.2 rubles must remain 30 kopecks.
const toCents = value => Math.round((Number(value) || 0) * 100);
const fromCents = value => value / 100;
const deleted = record => record?.deleted === true || record?.deleted === 1
  || record?.deleted === '1' || record?.deleted === 'true';

function clientKey(record) {
  const value = record?.client?.id;
  if (value == null || (typeof value === 'string' && !/^\d+$/.test(value.trim()))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function attendanceOf(record) {
  const value = record?.attendance;
  if (value === undefined || value === null || value === '') return 0;
  const attendance = Number(value);
  return [0, 1, 2].includes(attendance) ? attendance : null;
}

function summarizeRecords(records, date) {
  const clients = new Set();
  let bookedCents = 0, completedCents = 0;
  for (const record of records || []) {
    const at = m.moscowParts(record?.datetime || record?.date);
    const attendance = attendanceOf(record);
    if (!at || at.date !== date || deleted(record) || attendance == null) continue;
    const key = clientKey(record);
    if (key) clients.add(key);
    let recordCents = 0;
    for (const service of Array.isArray(record.services) ? record.services : []) {
      // YClients `cost` is already the total for the service line.
      recordCents += toCents(service?.cost);
    }
    bookedCents += recordCents;
    if (attendance === 1) completedCents += recordCents;
  }
  return {
    clientCount: clients.size,
    completedAmount: fromCents(completedCents),
    bookedAmount: fromCents(bookedCents),
  };
}

const money = value => fromCents(toCents(value));

async function load(salonId, date) {
  const day = m.dateKey(date);
  const row = await db.oneOrNone(SUMMARY_SQL, [salonId, day]) || {};
  const records = overlay.applyOverlay(Array.isArray(row.records) ? row.records : [], Array.isArray(row.outbox) ? row.outbox : []);
  const recordSummary = summarizeRecords(records, day);
  return {
    date: day,
    clientCount: recordSummary.clientCount,
    total: money(row.total),
    cash: money(row.cash),
    cashless: money(row.cashless_amount),
    otherAmount: money(row.other_amount),
    completedAmount: recordSummary.completedAmount,
    bookedAmount: recordSummary.bookedAmount,
    loyaltyAmount: money(row.loyalty_amount),
    goodsAmount: money(row.goods_amount),
    pendingCount: Number(row.pending_count) || 0,
  };
}

module.exports = { load, summarizeRecords, toCents, SUMMARY_SQL };
