#!/usr/bin/env node
'use strict';
// Read-only by default; --write allowed only on the configured dev test database.
// Output contains aggregate counts only, never message text or dialog identities.
// node scripts/dialog-verdicts-e2e.js [--day=YYYY-MM-DD] [--salon=1] [--write] [--recompute]
require('dotenv').config();
const { pool } = require('../db');
const { runVerdicts } = require('../services/dialog-verdicts/run');
const { safeError } = require('../services/dialog-verdicts/errors');
const { STATUS_CODES } = require('../services/dialog-verdicts/taxonomy');

const args = process.argv.slice(2);
const opt = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const flag = (n) => args.includes(`--${n}`);
const msk = (shift) => new Date(Date.now() + shift * 86400e3).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const day = opt('day') || msk(-1);
const salonId = Number(opt('salon') || 1);
const from = opt('from') || day, to = opt('to') || day;
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
if (![from, to].every(validDay) || from > to || !Number.isInteger(salonId) || salonId < 1) throw new Error('Invalid period or salon');
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error('--day=YYYY-MM-DD'); process.exit(2); }

(async () => {
  if (flag('write') && new URL(process.env.DATABASE_URL).pathname !== '/loyalpro_test') throw new Error('Write requires dev test database');
  console.log(`salon ${salonId}, ${from}..${to}, ${flag('write') ? 'ЗАПИСЬ В БД' : 'сухой прогон'}, провайдер ${process.env.AGENT_PROVIDER}`);
  const t0 = Date.now();

  const counts = {};
  const r = await runVerdicts(
    { salonId, from, to, trigger: 'manual', recompute: flag('recompute') || !flag('write') },
    {
      dryRun: !flag('write'),
      onBatch: ({ verdicts }) => {
        for (const v of verdicts) counts[v.status] = (counts[v.status] || 0) + 1;
      },
    });
  const res = await r.done;
  console.log('\n' + '═'.repeat(70));
  console.log(`к анализу ${res.requested}, ок ${res.analyzed}, сбой ${res.failed}, пачек ${res.batches}, модель ${res.model}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  console.log('по статусам:', STATUS_CODES.map(c => `${c}=${counts[c] || 0}`).join(' '));
  if (res.requested > 0 && res.analyzed === 0) { console.error('✗ ни одного вердикта — смотреть лог невалидных ответов'); process.exit(1); }
  if (res.requested === 0) console.log('(за этот день диалог-дней к анализу нет: без --recompute уже проанализированные пропускаются)');
  await pool.end();
})().catch(e => { console.error('✗', safeError(e)); process.exit(1); });
