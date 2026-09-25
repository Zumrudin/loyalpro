#!/usr/bin/env node
'use strict';
// Ручной ПОЛНЫЙ runSync (730 дней записей + карточка и карта каждого клиента,
// ≈45 мин и ≈8 800 запросов к YClients). Из крона убран 25.09.2026 — это тот же
// прогон, что кнопка «Синхронизировать», только из консоли (для догона после
// сбоя или подключения салона). Запускать ночью: квота YClients общая с Милой.
// Запуск: cd backend && node scripts/run-full-sync.js [--salon 1]
require('dotenv').config();
const { db, pool } = require('../db');
const { runSync } = require('../services/loyalty');

const argv = process.argv.slice(2);
const salonId = Number(argv[argv.indexOf('--salon') + 1]) || 1;

(async () => {
  const salon = await db.one('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon?.yclients_company_id || !salon.yclients_user_token) throw new Error(`салон ${salonId}: YClients не настроен`);
  const running = await db.oneOrNone(
    `SELECT id FROM sync_logs WHERE salon_id=$1 AND status='running' AND started_at > NOW() - INTERVAL '2 hours'`, [salonId]);
  if (running) throw new Error(`уже идёт прогон sync_logs.id=${running.id}`);
  console.log(`salon=${salon.id} ${salon.name}: полный runSync стартует ${new Date().toISOString()}`);
  const r = await runSync(salon, 'manual', null);
  console.log('done:', JSON.stringify(r));
})().catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
