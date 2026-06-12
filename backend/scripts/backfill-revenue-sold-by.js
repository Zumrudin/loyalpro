#!/usr/bin/env node
'use strict';
// Бэкфилл sold_by_yc_staff_id («на кого записана продажа») для существующих
// revenue_operations категорий goods/abonement. Источник — master_id товарной
// транзакции YClients (GET /storage_operations/goods_transactions/{cid}/{id}).
//
// Использование:
//   node scripts/backfill-revenue-sold-by.js [--category abonement,goods] [--rate-ms 350] [--dry-run]

const { db, pool } = require('../db');
const { ycGet } = require('../services/yclients');
const { goodsTransactionRef } = require('../services/revenue');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--dry-run') { args['dry-run'] = true; continue; }
    if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  return args;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const args = parseArgs();
  const categories = (args.category || 'abonement,goods').split(',').map(s => s.trim()).filter(Boolean);
  const rateMs = parseInt(args['rate-ms'], 10) || 350;
  const dryRun = !!args['dry-run'];

  const salons = await db.any(
    `SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL`);

  let updated = 0, skipped = 0, failed = 0;
  for (const salon of salons) {
    const ops = await db.any(
      `SELECT id, category, raw_payload FROM revenue_operations
       WHERE salon_id=$1 AND category = ANY($2) AND sold_by_yc_staff_id IS NULL
       ORDER BY id`, [salon.id, categories]);
    console.log(`salon=${salon.id} (${salon.name}): ${ops.length} ops to process`);

    for (const op of ops) {
      // goodsTransactionRef понимает обе формы: webhook {data:{...}} и плоский item
      const ref = goodsTransactionRef(op.raw_payload);
      if (!ref) { skipped++; continue; }

      let gt;
      for (let attempt = 1; ; attempt++) {
        try {
          gt = await ycGet(salon, `/storage_operations/goods_transactions/${salon.yclients_company_id}/${ref}`);
          break;
        } catch (e) {
          if (e.response?.status === 429 && attempt <= 3) {
            console.warn(`  429 on op=${op.id} — sleep 5s (attempt ${attempt})`);
            await sleep(5000);
            continue;
          }
          console.warn(`  op=${op.id} sold_item_id=${ref}: ${e.message}`);
          gt = null;
          break;
        }
      }
      if (!gt) { failed++; await sleep(rateMs); continue; }

      const masterId = parseInt(gt.master_id, 10);
      if (!Number.isFinite(masterId) || masterId <= 0) {
        console.log(`  op=${op.id} (${op.category}): master_id отсутствует — пропуск`);
        skipped++;
      } else if (dryRun) {
        console.log(`  [dry-run] op=${op.id} (${op.category}) → sold_by=${masterId} (${gt.master?.name || '?'})`);
        updated++;
      } else {
        await db.query(
          `UPDATE revenue_operations SET sold_by_yc_staff_id=$1 WHERE id=$2`, [masterId, op.id]);
        console.log(`  op=${op.id} (${op.category}) → sold_by=${masterId} (${gt.master?.name || '?'})`);
        updated++;
      }
      await sleep(rateMs);
    }
  }
  console.log(`\nDone${dryRun ? ' (dry-run)' : ''}: updated=${updated} skipped=${skipped} failed=${failed}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
