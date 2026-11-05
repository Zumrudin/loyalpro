#!/usr/bin/env node
'use strict';
// Живой EXPLAIN ANALYZE SQL отчёта экономики с НАСТОЯЩИМИ bound-параметрами
// (готча проекта: литералы не ловят вывод типов $N) + замер loadPeriod.
//   node scripts/economics-explain.js [salonId] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--plan]
// Порог спеки: отчёт за квартал ≤ 1 с. В БД ничего не пишет (только SELECT/EXPLAIN).
const { db, pool } = require('../db');
const S = require('../services/economics/store');

const args = process.argv.slice(2);
const salonId = Number(args.find(a => /^\d+$/.test(a)) || 1);
const opt = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const msk = (shift = 0) => new Date(Date.now() + shift * 86400e3).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const to = opt('to') || msk(0);
const from = opt('from') || msk(-89);

async function explain(label, sql, params) {
  const plan = await db.any('EXPLAIN (ANALYZE, BUFFERS) ' + sql, params);
  const lines = plan.map(r => r['QUERY PLAN']);
  const seq = lines.filter(l => /Seq Scan on/.test(l)).map(l => l.trim().replace(/\s+\(cost.*$/, ''));
  console.log(`${label}: ${lines.find(l => /^Execution Time/.test(l))}${seq.length ? `  [${seq.join('; ')}]` : ''}`);
  if (args.includes('--plan')) console.log(lines.join('\n'));
}

(async () => {
  console.log(`salon ${salonId}, период ${from}..${to}`);
  await explain('RECORDS_SQL', S.RECORDS_SQL, [salonId, from, to]);
  const recs = await db.any(S.RECORDS_SQL, [salonId, from, to]);
  const ids = recs.map(r => Number(r.record_id));
  if (ids.length) {
    await explain('CONSUMABLES_SQL', S.CONSUMABLES_SQL, [salonId, ids]);
    await explain('PAYMENTS_SQL', S.PAYMENTS_SQL, [salonId, ids]);
  }
  const goods = (await db.any('SELECT DISTINCT good_id FROM goods_transactions WHERE salon_id=$1 AND good_id IS NOT NULL', [salonId]))
    .map(g => Number(g.good_id));
  await explain('RECEIPTS_SQL', S.RECEIPTS_SQL, [salonId, goods, to]);
  await explain('CATALOG_SQL', S.CATALOG_SQL, [salonId, goods]);
  await explain('CAPACITY_SQL', S.CAPACITY_SQL, [salonId, from, to]);
  await explain('GAP_DAYS_SQL', S.GAP_DAYS_SQL, [salonId, from, to]);
  for (const k of ['OVERRIDES_SQL', 'CARDS_SQL', 'LINKS_SQL', 'PAY_RULES_SQL', 'SETTINGS_SQL', 'FIXED_SQL', 'EQUIPMENT_SQL']) {
    await explain(k, S[k], [salonId]);
  }
  // Холодный прогон открывает новые соединения пула (параллельные запросы) — на
  // деве через туннель это ~350 мс на соединение; порог меряется на тёплом.
  let t = Date.now();
  await S.loadPeriod(salonId, from, to);
  const cold = Date.now() - t;
  t = Date.now();
  const d = await S.loadPeriod(salonId, from, to);
  const ms = Date.now() - t;
  console.log(`loadPeriod холодный: ${cold} мс`);
  const recsWithCons = d.records.filter(r => r.consumables.length).length;
  const recsWithPay = d.records.filter(r => r.payments.length).length;
  const bonus = d.records.reduce((a, r) => a + r.bonus_redeemed, 0);
  console.log(`loadPeriod: ${d.records.length} записей (со списаниями ${recsWithCons}, с оплатами ${recsWithPay}, бонусами списано ${Math.round(bonus)} ₽), `
    + `${d.records.reduce((a, r) => a + r.consumables.length, 0)} списаний, ${d.receiptsByGood.size} товаров с приходами, `
    + `${d.catalogByGood.size} в каталоге, ${d.cards.size} карт, ${d.links.length} привязок, ${d.payRules.length} правил, `
    + `мощность ${d.capacityMinutes} мин — ${ms} мс`);
  if (ms > 1000) { console.error('ПРЕВЫШЕН порог 1 с'); process.exitCode = 1; }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
