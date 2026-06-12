#!/usr/bin/env node
'use strict';
// Сверка revenue_operations с YClients: находит операции, которые в YClients
// уже удалены (webhook delete не дошёл), и удаляет их у нас. Зависшие операции
// завышают выручку на дашбордах (кейс: оплату переразбили на кассу+счёт,
// старая операция удалена в YClients, но осталась в нашей БД).
//
// Логика — в services/revenue-reconcile.js (её же использует ежедневный cron,
// сверяющий последние 7 дней). Скрипт — для ручной сверки произвольного периода.
//
// Использование:
//   node scripts/reconcile-revenue-ops.js --from 2026-05-01 --to 2026-06-12 [--apply] [--rate-ms 300]
// Без --apply — только отчёт (dry-run).

const { db, pool } = require('../db');
const { reconcileSalon } = require('../services/revenue-reconcile');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--apply') { args.apply = true; continue; }
    if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  return args;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

async function main() {
  const args = parseArgs();
  if (!isDate(args.from) || !isDate(args.to)) {
    console.error('Usage: node scripts/reconcile-revenue-ops.js --from YYYY-MM-DD --to YYYY-MM-DD [--apply]');
    process.exit(1);
  }
  const rateMs = parseInt(args['rate-ms'], 10) || 300;
  const apply = !!args.apply;

  const salons = await db.any(
    `SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL`);

  let staleTotal = 0, deletedTotal = 0;
  for (const salon of salons) {
    console.log(`salon=${salon.id} (${salon.name}), период ${args.from}..${args.to}`);
    const r = await reconcileSalon(salon, args.from, args.to, {
      apply, rateMs,
      onStale: (o, day) =>
        console.log(`  ${day}: зависшая op_id=${o.yclients_operation_id} (${o.category}, ${o.amount} ₽)${apply ? ' — удаляю' : ''}`),
    });
    staleTotal += r.stale.length;
    deletedTotal += r.deleted;
  }
  console.log(`\nDone${apply ? '' : ' (dry-run)'}: зависших=${staleTotal}${apply ? `, удалено=${deletedTotal}` : ' (запустите с --apply для удаления)'}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
