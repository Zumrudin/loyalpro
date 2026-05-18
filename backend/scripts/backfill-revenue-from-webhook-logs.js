#!/usr/bin/env node
'use strict';

const { pool, db } = require('../db');
const { classifyExpense } = require('../services/revenue');
const { createLogger } = require('../logger');

const logger = createLogger('BackfillWebhookLogs');

async function main() {
  const salons = await db.any('SELECT id, yclients_company_id FROM salons WHERE is_active=TRUE');
  const salonMap = Object.fromEntries(salons.map(s => [s.id, s]));

  const events = await db.any(`
    SELECT id, salon_id, payload
    FROM webhook_logs
    WHERE event_type = 'finances_operation'
    ORDER BY id
  `);

  console.log(`Processing ${events.length} finances_operation events from webhook_logs...`);

  let inserted = 0, skipped = 0, errors = 0;

  for (const event of events) {
    const salon = salonMap[event.salon_id];
    if (!salon) { skipped++; continue; }

    const payload = typeof event.payload === 'string'
      ? JSON.parse(event.payload)
      : event.payload;

    if (payload.status === 'delete') { skipped++; continue; }

    const data = payload.data || {};
    const amount = parseFloat(data.amount || 0);
    if (amount <= 0) { skipped++; continue; }

    const category = classifyExpense(data.expense?.title);
    if (!category) { skipped++; continue; }

    try {
      const operationAt = new Date(data.date);
      const operationDate = operationAt.toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });
      const clientYcId = data.client?.id || null;
      const rawRecordId = data.record_id || data.record?.id;
      const ycRecordId = (rawRecordId && rawRecordId !== 0) ? rawRecordId : null;

      let clientId = null;
      if (clientYcId) {
        const client = await db.oneOrNone(
          'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
          [salon.id, clientYcId]
        );
        clientId = client?.id || null;
      }

      const result = await db.query(`
        INSERT INTO revenue_operations
          (salon_id, yclients_operation_id, category, amount, operation_date, operation_at,
           client_id, yclients_client_id, yclients_record_id,
           expense_id, expense_title, sold_item_type, account_title, is_cash, raw_payload, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (salon_id, yclients_operation_id) DO NOTHING
      `, [
        salon.id, data.id, category, amount, operationDate, operationAt,
        clientId, clientYcId, ycRecordId,
        data.expense?.id || null, data.expense?.title || null,
        data.sold_item_type || null, data.account?.title || null,
        data.account?.is_cash ?? null, payload, 'webhook_logs_backfill',
      ]);

      if (result.rowCount > 0) inserted++;
      else skipped++;
    } catch (e) {
      logger.error(`event ${event.id}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\nDone. Inserted: ${inserted}, Skipped/existing: ${skipped}, Errors: ${errors}`);

  // Reconciliation for the first active salon
  if (salons.length > 0) {
    const s1 = salons[0];
    const range = await db.oneOrNone(`
      SELECT MIN(operation_date)::text AS min_date, MAX(operation_date)::text AS max_date
      FROM revenue_operations WHERE salon_id=$1
    `, [s1.id]);

    if (range && range.min_date) {
      const r = await db.one(`
        SELECT
          (SELECT COALESCE(SUM(amount),0) FROM records
           WHERE salon_id=$1 AND status IN ('completed','confirmed','arrived')
             AND COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)
             BETWEEN $2::date AND $3::date) AS records_services,
          (SELECT COALESCE(SUM(amount),0) FROM revenue_operations
           WHERE salon_id=$1 AND category='services'
             AND operation_date BETWEEN $2::date AND $3::date) AS rev_ops_services
      `, [s1.id, range.min_date, range.max_date]);

      const diff = Math.abs(parseFloat(r.records_services) - parseFloat(r.rev_ops_services));
      const pct = parseFloat(r.records_services) > 0
        ? (diff / parseFloat(r.records_services) * 100).toFixed(1)
        : '0.0';

      console.log(`\nReconciliation (salon_id=${s1.id}, ${range.min_date}..${range.max_date}):`);
      console.log(`  records.amount services:       ${r.records_services}`);
      console.log(`  revenue_operations services:   ${r.rev_ops_services}`);
      console.log(`  Difference: ${diff} (${pct}%)`);
      if (parseFloat(pct) > 5) {
        console.warn('  WARNING: Difference > 5% — investigate');
      } else {
        console.log('  OK: Within 5% tolerance');
      }
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
