#!/usr/bin/env node
'use strict';
// Живая проверка ночной сверки с YClients (services/yclients-reconcile.js) на
// деве: один прогон против РЕАЛЬНОГО YClients выбранного салона и дев-БД.
// Денег не пишет по построению (сверка кэшбэк не начисляет; linkClientCard
// только привязывает карту). Запуск: cd backend && node scripts/yclients-reconcile-e2e.js [--salon 1]
require('dotenv').config();
const { db, pool } = require('../db');
const rec = require('../services/yclients-reconcile');

const argv = process.argv.slice(2);
const salonId = Number(argv[argv.indexOf('--salon') + 1]) || 1;

(async () => {
  const salon = await db.one('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon?.yclients_company_id) throw new Error(`салон ${salonId}: нет yclients_company_id`);
  console.log(`salon=${salon.id} ${salon.name} card_type=${salon.yclients_card_type_id || '-'} changed_after=${rec.changedAfterDate()}`);

  const before = await db.one(`SELECT count(*)::int n FROM records WHERE salon_id=$1`, [salon.id]);
  const t0 = Date.now();
  const r = await rec.reconcileDaily(salon);
  const after = await db.one(`SELECT count(*)::int n FROM records WHERE salon_id=$1`, [salon.id]);
  const log = await db.one(`SELECT id, status, sync_type, clients_synced, records_synced, finished_at
                            FROM sync_logs WHERE salon_id=$1 ORDER BY id DESC LIMIT 1`, [salon.id]);
  console.log('result:', JSON.stringify(r));
  console.log(`records: ${before.n} → ${after.n} (+${after.n - before.n}); ${Date.now() - t0}ms`);
  console.log('sync_logs:', JSON.stringify(log));
  const fresh = await db.any(`SELECT count(*)::int n FROM clients WHERE salon_id=$1 AND synced_at > NOW() - INTERVAL '5 minutes'`, [salon.id]);
  console.log(`clients с synced_at за 5 мин: ${fresh[0].n}`);
  if (log.status !== 'success' || log.sync_type !== 'daily') throw new Error('sync_logs: ожидался daily/success');
  if (fresh[0].n < r.clients) throw new Error('клиенты не обновлены');
  // Ошибка по клиенту не фатальна для прогона, но для ПРОВЕРКИ — да: первый живой
  // запуск отдал clients=10 errors=50 при зелёном sync_logs (тип параметра SQL).
  if (r.clientErrors > 0) throw new Error(`ошибок по клиентам: ${r.clientErrors} — смотри WARN выше`);
  console.log('OK');
})().catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
