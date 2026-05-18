#!/usr/bin/env node
'use strict';

const { db, pool } = require('../db');
const { classifyExpense } = require('../services/revenue');
const { ycListFinanceTransactions } = require('../services/yclients');
const { createLogger } = require('../logger');

const logger = createLogger('BackfillYClients');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      args[process.argv[i].slice(2)] = process.argv[i + 1];
      i++;
    }
  }
  return args;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function backfillSalon(salon, { dateFrom, dateTo, rateLimitMs }) {
  let page = 1;
  let inserted = 0, skipped = 0, errors = 0;

  while (true) {
    let rows;
    try {
      rows = await ycListFinanceTransactions(salon, {
        dateFrom, dateTo, page, count: 50,
      });
    } catch (e) {
      if (e.response?.status === 429) {
        console.warn(`Rate limited — sleeping 5s then retry`);
        await sleep(5000);
        continue;
      }
      throw e;
    }

    if (!rows || rows.length === 0) break;
    console.log(`  Page ${page}: ${rows.length} rows`);

    for (const item of rows) {
      const amount = parseFloat(item.amount || 0);
      if (amount <= 0) { skipped++; continue; }

      const expenseTitle = item.expense?.title || null;
      const category = classifyExpense(expenseTitle);
      if (!category) { skipped++; continue; }

      try {
        const operationAt = new Date(item.date);
        const operationDate = operationAt.toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });
        const clientYcId = item.client?.id || null;
        const ycRecordId = (item.record_id && item.record_id !== 0) ? item.record_id : null;

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
             expense_id, expense_title, sold_item_type, account_title, is_cash, source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (salon_id, yclients_operation_id) DO NOTHING
        `, [
          salon.id, item.id, category, amount, operationDate, operationAt,
          clientId, clientYcId, ycRecordId,
          item.expense?.id || null, expenseTitle,
          item.sold_item_type || null, item.account?.title || null,
          item.account?.is_cash ?? null, 'api_backfill',
        ]);

        if (result.rowCount > 0) inserted++;
        else skipped++;
      } catch (e) {
        logger.error(`item ${item.id}: ${e.message}`);
        errors++;
      }
    }

    if (rows.length < 50) break;
    page++;
    await sleep(rateLimitMs);
  }

  return { inserted, skipped, errors };
}

async function main() {
  const args = parseArgs();
  const salonId = parseInt(args['salon-id']);
  const dateFrom = args['from'];
  const dateTo = args['to'];
  const rateLimitMs = parseInt(args['rate-limit-ms'] || '300');

  if (!salonId || !dateFrom || !dateTo) {
    console.error('Usage: --salon-id N --from YYYY-MM-DD --to YYYY-MM-DD [--rate-limit-ms 300]');
    process.exit(1);
  }

  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1 AND is_active=TRUE', [salonId]);
  if (!salon) { console.error(`Salon ${salonId} not found`); process.exit(1); }

  console.log(`Backfilling salon ${salonId} (${salon.yclients_company_id}) from ${dateFrom} to ${dateTo}`);
  console.log(`Rate limit: ${rateLimitMs}ms between pages`);

  const result = await backfillSalon(salon, { dateFrom, dateTo, rateLimitMs });
  console.log(`\nDone. Inserted: ${result.inserted}, Skipped/existing: ${result.skipped}, Errors: ${result.errors}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
