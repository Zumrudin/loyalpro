#!/usr/bin/env node
'use strict';
// Живой EXPLAIN ANALYZE статистики переписок (services/messenger-stats.js) на
// дев-БД — с НАСТОЯЩИМИ связанными параметрами, а не подставленными литералами:
// именно на выводе типов параметров ($2/$3 как date из CTE m) запрос однажды
// падал «operator does not exist: text >= date», чего EXPLAIN с литералами не
// показывал. Тот же приём, что живой EXPLAIN LEASE_SQL у воркеров.
//
//   node scripts/messenger-stats-explain.js [salonId] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
//
// По умолчанию salon 1 и последние 30 дней по Москве до сегодня. Печатает
// Execution Time плана, затем гонит боевой loadMessengerStats + summarize и
// печатает итоги и разрез по каналам. Инварианты (dialogs ≥ client_first ≥
// booked_same_day ≥ booked_by_agent, no_phone ≤ client_first) проверяются по
// каждой строке — нарушение = exit 1. Порог спеки — ≤300 мс на месяце.
// В БД ничего не пишет.
const { db, pool } = require('../db');
const { MESSENGER_STATS_SQL, loadMessengerStats, summarize } = require('../services/messenger-stats');

const args = process.argv.slice(2);
const salonId = Number(args.find(a => /^\d+$/.test(a)) || 1);
const opt = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

function mskDate(shiftDays = 0) {
  const now = new Date(Date.now() + shiftDays * 86400e3);
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }); // 'YYYY-MM-DD'
}
const to = opt('to') || mskDate(0);
const from = opt('from') || mskDate(-29);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  console.error('даты только в формате YYYY-MM-DD');
  process.exit(2);
}

(async () => {
  console.log(`salon ${salonId}, период ${from}..${to}`);

  const plan = await db.any('EXPLAIN (ANALYZE, BUFFERS) ' + MESSENGER_STATS_SQL, [salonId, from, to]);
  const lines = plan.map(r => r['QUERY PLAN']);
  const exec = lines.find(l => /^Execution Time/.test(l));
  const planning = lines.find(l => /^Planning Time/.test(l));
  console.log(planning, '|', exec);
  if (args.includes('--plan')) console.log(lines.join('\n'));

  const t = Date.now();
  const rows = await loadMessengerStats(salonId, from, to);
  const ms = Date.now() - t;
  const s = summarize(rows, { from, to });
  console.log(`loadMessengerStats: ${rows.length} строк за ${ms} мс (с сетью)`);
  console.log('totals', JSON.stringify(s.totals));
  console.log('byChannel', s.byChannel.map(c =>
    `${c.label}:${c.dialogs}/${c.clientFirst}/${c.bookedSameDay}/${c.bookedByAgent}`).join(' ') || '(пусто)');
  console.log(`daily ${s.daily.length} дн.`);

  const bad = rows.filter(r => {
    const verdictSum = Object.keys(r)
      .filter(key => key.startsWith('v_'))
      .reduce((sum, key) => sum + Number(r[key] || 0), 0);
    return !(Number(r.dialogs) >= Number(r.client_first)
      && Number(r.client_first) >= Number(r.booked_same_day)
      && Number(r.booked_same_day) >= Number(r.booked_by_agent)
      && Number(r.client_first_no_phone) <= Number(r.client_first)
      && verdictSum === Number(r.dialogs));
  });
  if (bad.length) {
    console.error(`ИНВАРИАНТ НАРУШЕН в ${bad.length} строк(ах):`, JSON.stringify(bad.slice(0, 5)));
    process.exit(1);
  }
  console.log(`инварианты: ok (${rows.length} строк)`);
  const execMs = exec ? parseFloat(exec.replace(/[^\d.]/g, '')) : NaN;
  if (execMs > 300) console.warn(`ВНИМАНИЕ: Execution Time ${execMs} мс выше порога спеки 300 мс`);
})().catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
