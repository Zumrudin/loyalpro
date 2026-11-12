'use strict';
// Перенос истории в finance_operations (спека 2026-11-12-finance-operations-design.md, этап 2).
//   node scripts/finance-ops-backfill.js --salon=1 [--write]
// По умолчанию — СУХОЙ прогон: те же upsert-функции services/finance-ops.js идут во ВРЕМЕННУЮ
// таблицу сессии (TEMP, исчезает с соединением), боевые таблицы не меняются; печатаются счётчики и суммы
// по kind/status/origin. Источники только читаются: journal_outbox, journal_financial_transactions,
// revenue_operations, loyalty_card_transactions. С --write строки пишутся в finance_operations;
// повторный запуск ничего не добавляет (идемпотентные ключи). --write разрешён только на БД loyalpro_test.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const config = require('../config');
const { pool } = require('../db');
const { FINANCE_OPS_DDL } = require('../migrations');
const ops = require('../services/finance-ops');

const usage = () => console.log('Usage: node scripts/finance-ops-backfill.js --salon=1 [--write]');

// DDL без внешних ключей: на TEMP-таблицу ссылки на постоянные таблицы запрещены.
function tempDdl() {
  return FINANCE_OPS_DDL.replace(/\s+REFERENCES\s+\w+\(\w+\)(\s+ON DELETE (CASCADE|SET NULL))?/g, '');
}

const fmt = n => (Math.round(Number(n) * 100) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 });

async function main() {
  let salonId = null, write = false;
  for (const a of process.argv.slice(2)) {
    let m;
    if (a === '--write') write = true;
    else if ((m = a.match(/^--salon=(\d+)$/))) salonId = Number(m[1]);
    else { usage(); process.exitCode = 2; return; }
  }
  if (!salonId) { usage(); process.exitCode = 2; return; }

  let dbName = '';
  try { dbName = new URL(config.DATABASE_URL).pathname; } catch (_) { /* ниже отказ */ }
  if (write && dbName !== '/loyalpro_test') {
    console.error(`finance-ops-backfill: --write только для дев-БД loyalpro_test (сейчас «${dbName || '?'}») — отказ`);
    process.exitCode = 2; return;
  }

  const client = await pool.connect();
  try {
    const q = (sql, params) => client.query(sql, params);
    let exists = false;
    if (!write) {
      const reg = (await q(`SELECT to_regclass('public.finance_operations') AS t`)).rows[0].t;
      exists = !!reg;
      await q(tempDdl().replace(/CREATE TABLE IF NOT EXISTS finance_operations/, 'CREATE TEMP TABLE finance_operations'));
      // Индексы temp-таблицы живут в её схеме; имена совпадают с боевыми — IF NOT EXISTS проверяет pg_temp.
    }
    const salon = (await q('SELECT id, name FROM salons WHERE id=$1', [salonId])).rows[0];
    if (!salon) { console.error('salon not found'); process.exitCode = 1; return; }

    const counts = { inserted: 0, updated: 0, linked: 0 };
    const bySrc = {};
    const tally = await ops.syncSources(salonId, {
      origin: 'backfill', q,
      onResult: (src, r) => {
        counts[r.action] = (counts[r.action] || 0) + 1;
        (bySrc[src] = bySrc[src] || { inserted: 0, updated: 0, linked: 0 })[r.action]++;
      },
    });
    // «Повторный» проход: ни одной новой строки.
    let again = 0;
    await ops.syncSources(salonId, { origin: 'backfill', q, onResult: (_s, r) => { if (r.action === 'inserted') again++; } });

    console.log(`finance_operations backfill, salon ${salonId} (${salon.name}), БД ${dbName}, режим: ${write ? 'WRITE' : 'dry-run (TEMP-таблица)'}`);
    if (!write) console.log(`боевая таблица finance_operations ${exists ? 'уже есть' : 'ещё не создана (миграция не применена)'}`);
    console.log(`источники: journal=${tally.journal} revenue=${tally.revenue} loyalty=${tally.loyalty} ошибок=${tally.errors}`);
    console.log(`результат: вставлено=${counts.inserted} обновлено=${counts.updated} связано с журналом=${counts.linked}`);
    for (const [src, c] of Object.entries(bySrc)) console.log(`  ${src}: вставлено=${c.inserted} обновлено=${c.updated} связано=${c.linked}`);
    console.log(`повторный проход: новых строк=${again}`);

    const rows = (await q(`SELECT kind, status, origin, count(*)::int AS n, sum(amount) AS total
      FROM finance_operations WHERE salon_id=$1 GROUP BY 1,2,3 ORDER BY 1,2,3`, [salonId])).rows;
    console.log('\nkind                 status     origin     rows        sum');
    for (const r of rows) console.log(`${r.kind.padEnd(20)} ${r.status.padEnd(10)} ${r.origin.padEnd(10)} ${String(r.n).padStart(4)} ${fmt(r.total).padStart(14)}`);
    const tot = (await q(`SELECT method, count(*)::int AS n, sum(amount) AS total FROM finance_operations
      WHERE salon_id=$1 AND status IN ('queued','sending','confirmed') GROUP BY 1 ORDER BY 1`, [salonId])).rows;
    console.log('\nпо способу (queued+sending+confirmed):');
    for (const r of tot) console.log(`  ${(r.method || '-').padEnd(6)} ${String(r.n).padStart(4)} строк, сумма ${fmt(r.total)}`);
    const by = (await q(`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE client_id IS NULL)::int AS no_client,
      count(*) FILTER (WHERE yclients_record_id IS NULL)::int AS no_record,
      count(*) FILTER (WHERE step_op_id IS NOT NULL AND (revenue_operation_id IS NOT NULL OR loyalty_txn_id IS NOT NULL))::int AS journal_linked
      FROM finance_operations WHERE salon_id=$1`, [salonId])).rows[0];
    console.log(`\nвсего строк=${by.n}, без клиента=${by.no_client}, без визита=${by.no_record}, строк журнала со ссылкой на выручку/бонус=${by.journal_linked}`);
    if (!write) console.log('\nСухой прогон: ничего не записано. Для записи на дев-БД добавьте --write.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error('finance-ops-backfill failed:', e.message); process.exitCode = 1; pool.end().catch(() => {}); });
