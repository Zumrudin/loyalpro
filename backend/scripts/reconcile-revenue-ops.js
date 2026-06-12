#!/usr/bin/env node
'use strict';
// Сверка revenue_operations с YClients: находит операции, которые в YClients
// уже удалены (webhook delete не дошёл), и удаляет их у нас. Зависшие операции
// завышают выручку на дашбордах (кейс: оплату переразбили на кассу+счёт,
// старая операция удалена в YClients, но осталась в нашей БД).
//
// Использование:
//   node scripts/reconcile-revenue-ops.js --from 2026-05-01 --to 2026-06-12 [--apply] [--rate-ms 300]
// Без --apply — только отчёт (dry-run).

const { db, pool } = require('../db');
const { ycGet } = require('../services/yclients');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--apply') { args.apply = true; continue; }
    if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  return args;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Все операции YClients за день (с пагинацией).
async function fetchDayOps(salon, day, rateMs) {
  const ids = new Set();
  for (let page = 1; ; page++) {
    let rows;
    for (let attempt = 1; ; attempt++) {
      try {
        rows = await ycGet(salon, `/transactions/${salon.yclients_company_id}`, {
          start_date: day, end_date: day, page, count: 200,
        });
        break;
      } catch (e) {
        if (e.response?.status === 429 && attempt <= 3) { await sleep(5000); continue; }
        throw e;
      }
    }
    if (!rows || rows.length === 0) break;
    for (const t of rows) ids.add(String(t.id));
    if (rows.length < 200) break;
    await sleep(rateMs);
  }
  return ids;
}

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

  let staleTotal = 0, deleted = 0;
  for (const salon of salons) {
    console.log(`salon=${salon.id} (${salon.name}), период ${args.from}..${args.to}`);
    for (let day = args.from; day <= args.to; day = addDays(day, 1)) {
      const ours = await db.any(
        `SELECT id, yclients_operation_id, category, amount
         FROM revenue_operations WHERE salon_id=$1 AND operation_date=$2::date`,
        [salon.id, day]);
      if (!ours.length) continue;

      let ycIds;
      try {
        ycIds = await fetchDayOps(salon, day, rateMs);
      } catch (e) {
        console.warn(`  ${day}: YClients недоступен (${e.message}) — день пропущен`);
        continue;
      }

      const stale = ours.filter(o => !ycIds.has(String(o.yclients_operation_id)));
      for (const s of stale) {
        staleTotal++;
        console.log(`  ${day}: зависшая op_id=${s.yclients_operation_id} (${s.category}, ${s.amount} ₽)${apply ? ' — удаляю' : ''}`);
        if (apply) {
          await db.query(`DELETE FROM revenue_operations WHERE id=$1`, [s.id]);
          deleted++;
        }
      }
      await sleep(rateMs);
    }
  }
  console.log(`\nDone${apply ? '' : ' (dry-run)'}: зависших=${staleTotal}${apply ? `, удалено=${deleted}` : ' (запустите с --apply для удаления)'}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
