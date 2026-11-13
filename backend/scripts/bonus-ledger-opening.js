#!/usr/bin/env node
'use strict';
// Входящие остатки бонусов (спека 2026-11-12-finance-operations-design.md, этап 3).
//   node scripts/bonus-ledger-opening.js --salon=1            — сухой прогон: план, ничего не пишет
//   node scripts/bonus-ledger-opening.js --salon=1 --write    — записать (только loyalpro_test и только
//                                                                 при BONUS_LEDGER_PRIMARY=true в .env)
//   --show=N — напечатать N клиентов, у которых баланс изменится сильнее всего (по умолчанию 15)
//
// Остаток клиента с картой = показание карты YClients − подтверждённая бонусная история в
// finance_operations. После него наш баланс = карта + неотправленные операции журнала.
// Повторный запуск ничего не добавляет (одна строка bonus_opening на клиента).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const config = require('../config');
const { pool } = require('../db');
const ledger = require('../services/bonus-ledger');

const usage = () => console.log('Usage: node scripts/bonus-ledger-opening.js --salon=1 [--write] [--show=N]');
const fmt = n => (Math.round(Number(n) * 100) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 });

async function main() {
  let salonId = null, write = false, show = 15;
  for (const a of process.argv.slice(2)) {
    let m;
    if (a === '--write') write = true;
    else if ((m = a.match(/^--salon=(\d+)$/))) salonId = Number(m[1]);
    else if ((m = a.match(/^--show=(\d+)$/))) show = Number(m[1]);
    else { usage(); process.exitCode = 2; return; }
  }
  if (!salonId) { usage(); process.exitCode = 2; return; }
  let dbName = '';
  try { dbName = new URL(config.DATABASE_URL).pathname; } catch (_) { /* ниже отказ */ }
  if (write && dbName !== '/loyalpro_test') {
    console.error(`bonus-ledger-opening: --write только для дев-БД loyalpro_test (сейчас «${dbName || '?'}») — отказ`); process.exitCode = 2; return;
  }
  if (write && !ledger.isPrimary()) {
    // Без флага сервер продолжит присваивать bonus_balance из карты, и журнал разойдётся с балансом.
    console.error('bonus-ledger-opening: --write только при BONUS_LEDGER_PRIMARY=true (в .env и у процесса loyalpro) — отказ'); process.exitCode = 2; return;
  }

  const client = await pool.connect();
  try {
    const q = (sql, params) => client.query(sql, params);
    const p = await ledger.openingPlan(salonId, { q });
    console.log(`клиентов с картой без входящего остатка: ${p.clients}`);
    console.log(`  с бонусной историей в журнале: ${p.withHistory}; с неотправленными списаниями: ${p.withUnsent}`);
    console.log(`  остаток < 0 (история больше карты): ${p.negativeOpening}`);
    console.log(`  баланс изменится (≥1 ₽ от текущего bonus_balance): ${p.balanceChanges}`);
    console.log(`  сумма показаний карт: ${fmt(p.sumCard)}; сумма остатков: ${fmt(p.sumOpening)}`);
    const changed = p.plan.filter(x => Math.abs(x.balanceAfter - x.current) >= 1)
      .sort((a, b) => Math.abs(b.balanceAfter - b.current) - Math.abs(a.balanceAfter - a.current)).slice(0, show);
    if (changed.length) {
      console.log('\nclient   текущий   карта   история   очередь   остаток   станет');
      for (const x of changed) console.log(`${String(x.clientId).padEnd(8)} ${fmt(x.current).padStart(9)} ${fmt(x.card).padStart(9)} ${fmt(x.history).padStart(9)} ${fmt(x.unsent).padStart(9)} ${fmt(x.opening).padStart(9)} ${fmt(x.balanceAfter).padStart(9)}`);
    }
    if (!write) { console.log('\nСухой прогон: ничего не записано.'); return; }

    let written = 0;
    for (const x of p.plan) { if (await ledger.ensureOpening(x.clientId, { q })) written++; }
    const again = await ledger.openingPlan(salonId, { q });
    const diffs = await ledger.discrepancies(salonId, { q, limit: 1000 });
    console.log(`\nзаписано остатков: ${written}; осталось без остатка: ${again.clients}; расхождений с картой: ${diffs.length}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
