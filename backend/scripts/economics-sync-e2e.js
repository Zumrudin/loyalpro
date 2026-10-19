#!/usr/bin/env node
'use strict';
// Живой прогон ночного синка экономики на деве: каталог товаров, техкарты,
// сверка транзакций за 2 дня, обучение привязок. Пишет в ДЕВ-БД (как крон),
// никому ничего не шлёт. Печатает счётчики каждого шага и итоги по таблицам.
//   node scripts/economics-sync-e2e.js [salonId]
const { db, pool } = require('../db');
const sync = require('../services/economics/sync');

const salonId = Number(process.argv[2] || 1);
(async () => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon) throw new Error(`салон ${salonId} не найден`);
  const t0 = Date.now();
  const r = await sync.runNightly(salon);
  console.log(`ночной проход за ${Math.round((Date.now() - t0) / 1000)} с, ok=${r.ok}`);
  for (const [k, v] of Object.entries(r.steps)) console.log(`  ${k}:`, JSON.stringify(v));
  for (const [k, v] of Object.entries(r.errors)) console.log(`  ОШИБКА ${k}:`, v);
  const q = async (sql) => (await db.oneOrNone(sql, [salonId])) || {};
  console.log('каталог с unit_actual_cost:', await q('SELECT count(*)::int AS n FROM yclients_goods_catalog WHERE salon_id=$1 AND unit_actual_cost IS NOT NULL'));
  console.log('техкарты:', await q("SELECT count(*)::int AS n, sum(jsonb_array_length(items))::int AS items FROM tech_cards WHERE salon_id=$1 AND source='yclients'"));
  console.log('привязки:', await q('SELECT count(*)::int AS n, count(DISTINCT service_yc_id)::int AS services FROM service_tech_cards WHERE salon_id=$1'));
  console.log('транзакции за 3 дня:', await q("SELECT count(*)::int AS n FROM goods_transactions WHERE salon_id=$1 AND create_date > NOW() - INTERVAL '3 days'"));
  if (!r.ok) process.exitCode = 1;
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
