#!/usr/bin/env node
'use strict';
// Живой EXPLAIN (ANALYZE, BUFFERS) SQL воркера разовых рассылок через мессенджеры на дев-БД — с НАСТОЯЩИМИ
// связанными параметрами (id последней мессенджерной рассылки, массивы каналов), а не литералами: тот же приём,
// что в messenger-stats-explain.js (типы параметров выводит сам PostgreSQL, литералы этого не показывают).
//
//   node scripts/broadcast-messengers-explain.js [--id=<broadcastId>]
//
// Нет мессенджерных рассылок → id 0 (план по пустому набору; цифры мало что говорят — предупреждаем).
// ТОЛЬКО ЧТЕНИЕ: CLOSE_STALE_SQL — UPDATE, а ANALYZE его выполняет, поэтому он идёт в транзакции с ROLLBACK.
const { db, pool } = require('../db');
const w = require('../services/broadcast-messengers/worker');

const idArg = process.argv.slice(2).find(a => a.startsWith('--id='));
const CHANNELS = ['tdlib', 'whatsapp', 'max'];

async function explain(client, label, sql, params) {
  const { rows } = await client.query('EXPLAIN (ANALYZE, BUFFERS) ' + sql, params);
  const lines = rows.map(r => r['QUERY PLAN']);
  const pick = re => (lines.find(l => re.test(l)) || '').trim();
  console.log(`${label.padEnd(14)} ${pick(/^Planning Time/)} | ${pick(/^Execution Time/)}`);
  if (process.argv.includes('--plan')) console.log(lines.map(l => '    ' + l).join('\n'));
}

(async () => {
  let id = idArg ? Number(idArg.slice(5)) : null;
  if (id == null) {
    const r = await db.oneOrNone(`SELECT id FROM broadcasts WHERE transport = 'messengers' ORDER BY id DESC LIMIT 1`);
    id = r ? r.id : 0;
    if (!r) console.warn('⚠️  мессенджерных рассылок в дев-БД нет — EXPLAIN с id 0 (пустой набор, времена показательны слабо)');
  }
  const total = await db.oneOrNone('SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1', [id]);
  console.log(`рассылка #${id}, получателей ${total ? total.n : 0}`);

  const client = await pool.connect();
  try {
    await explain(client, 'ACTIVE', w.ACTIVE_SQL, []);
    await explain(client, 'STATS', w.STATS_SQL, [id]);
    await explain(client, 'HEADS', w.HEADS_SQL, [id, CHANNELS]);
    await explain(client, 'LIMIT_PENDING', w.LIMIT_PENDING_SQL, [id, CHANNELS]);
    await explain(client, 'CHECK', w.CHECK_SQL, []);
    await explain(client, 'HAS_OPEN', w.SQL.hasOpen, [id]);
    // CLOSE_STALE — запись: в транзакции и откат.
    await client.query('BEGIN');
    try { await explain(client, 'CLOSE_STALE', w.CLOSE_STALE_SQL, []); } finally { await client.query('ROLLBACK'); }

    // «Нет в мессенджере» (06.11.2026): STATS с записью not_registered в cascade_log (каст sent_at → timestamptz
    // и UNION-типы проверяются только на реальной строке) и пишущие запросы сверки — в транзакции с откатом.
    const row = await db.oneOrNone(
      `SELECT id, channel FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'sent' ORDER BY id LIMIT 1`, [id]);
    if (!row) {
      console.warn('⚠️  в рассылке нет отправленных строк — проверка not_registered пропущена');
    } else {
      const entry = JSON.stringify([{ at: new Date().toISOString(), from: row.channel, to: 'whatsapp', why: 'not_registered',
        error: 'Пользователь не найден в Telegram', sent_at: new Date(Date.now() - 60000).toISOString(), delivery_id: '1' }]);
      await client.query('BEGIN');
      try {
        await client.query(`UPDATE broadcast_recipients SET cascade_log = cascade_log || $2::jsonb, delivery_status = 'accepted' WHERE id = $1`, [row.id, entry]);
        const { rows: st } = await client.query(w.STATS_SQL, [id]);
        console.log('STATS с not_registered:', st.map(r => `${r.channel}: n=${r.n} last=${r.last_ms ? new Date(Number(r.last_ms)).toISOString() : '-'}`).join('; '));
        await explain(client, 'STATS+NR', w.STATS_SQL, [id]);
        await explain(client, 'DELIV_STATUS', w.SQL.deliveryStatus, [row.id, 'undeliverable', 'Клиент не зарегистрирован в MAX']);
        await client.query(`UPDATE broadcast_recipients SET delivery_status = 'accepted' WHERE id = $1`, [row.id]);
        await explain(client, 'NR_NEXT', w.SQL.notRegisteredNext, [row.id, 1, 'whatsapp', 'Пользователь не найден в Telegram', entry]);
        await explain(client, 'DEC_SENT', w.SQL.decSent, [id]);
      } finally { await client.query('ROLLBACK'); }
    }
  } finally {
    client.release();
  }
})().then(() => pool.end()).catch(async (e) => {
  console.error('ОШИБКА:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
