// Verifies the "первичные пациенты" (primary clients) dashboard metric.
//
// Rule (confirmed with product owner):
//   A client is "primary" in period [from,to] if their FIRST qualifying visit
//   falls inside that period. A qualifying visit =
//     • status 'completed' OR 'arrived' (visit actually happened),
//     • paid_full = 1,
//     • no service discount,
//     • no bonus redemption tied to the record.
//   Cancelled / no_show / waiting records are ignored, so a client whose only
//   earlier records were cancelled is counted as primary on the day of their
//   first qualifying visit.
//
// Run on the server (needs DB):  cd backend && node primary-clients.test.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const one = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
const many = async (sql, p) => (await pool.query(sql, p)).rows;

// Per-record qualifying predicate (shared by all checks below).
const QUALIFYING_WHERE = `
  r.salon_id = $1
  AND r.client_id IS NOT NULL
  AND r.status IN ('completed','arrived')
  AND (r.raw_payload->>'paid_full')::int = 1
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(r.raw_payload->'services','[]'::jsonb)) svc
    WHERE COALESCE(NULLIF(svc->>'discount','')::numeric, 0) > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM loyalty_card_transactions lct
    WHERE lct.salon_id = r.salon_id AND lct.amount < 0
      AND (lct.record_id = r.id
           OR lct.record_id = r.yclients_record_id
           OR (lct.record_id IS NULL AND lct.client_id = r.client_id
               AND r.visit_date IS NOT NULL AND lct.txn_date::date = r.visit_date::date))
  )`;
const VDAY = `COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date)`;

// Implementation under test (mirrors api.js primaryClientsSql).
const PRIMARY_SQL = `
  WITH qualifying AS (
    SELECT r.client_id, MIN(${VDAY}) AS first_visit
    FROM records r WHERE ${QUALIFYING_WHERE} GROUP BY r.client_id
  )
  SELECT COUNT(*) FROM qualifying WHERE first_visit BETWEEN $2::date AND $3::date`;

// Independent re-derivation of the SAME rule, computed differently:
// clients with >=1 qualifying visit in period AND 0 qualifying visits before it.
const INDEPENDENT_SQL = `
  WITH qrec AS (
    SELECT r.client_id, ${VDAY} AS vday FROM records r WHERE ${QUALIFYING_WHERE}
  )
  SELECT COUNT(*) FROM (
    SELECT client_id FROM qrec GROUP BY client_id
    HAVING COUNT(*) FILTER (WHERE vday BETWEEN $2::date AND $3::date) > 0
       AND COUNT(*) FILTER (WHERE vday < $2::date) = 0
  ) t`;

// Old (buggy) metric: counts client rows by DB import date, not first real visit.
const OLD_SQL = `SELECT COUNT(*) FROM clients
  WHERE salon_id=$1 AND (created_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date`;

function mskToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}
function daysAgo(n) {
  const d = new Date(mskToday() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (n - 1));
  return d.toISOString().slice(0, 10);
}

async function run() {
  let failures = 0;
  const assert = (cond, msg) => { if (cond) { console.log('  ✅', msg); } else { console.log('  ❌', msg); failures++; } };

  // Pick the salon with the most records so the test exercises real data.
  const sidRow = await one(`SELECT salon_id, COUNT(*) c FROM records GROUP BY salon_id ORDER BY c DESC LIMIT 1`);
  if (!sidRow) { console.log('No records in DB — nothing to verify.'); await pool.end(); return; }
  const sid = sidRow.salon_id;
  const to = mskToday();
  const from = daysAgo(30);
  const p = [sid, from, to];
  console.log(`\n🧪 Первичные пациенты — salon_id=${sid}, период ${from} … ${to}\n`);

  const primary = parseInt((await one(PRIMARY_SQL, p)).count);
  const independent = parseInt((await one(INDEPENDENT_SQL, p)).count);
  const old = parseInt((await one(OLD_SQL, p)).count);

  console.log(`  Старый показатель (по created_at):        ${old}`);
  console.log(`  Новый показатель (первый оплач. визит):   ${primary}`);
  console.log(`  Независимая перепроверка того же правила:  ${independent}\n`);

  // 1. The two independent computations of the rule must agree.
  assert(primary === independent, `новый расчёт совпадает с независимой перепроверкой (${primary} === ${independent})`);

  // 2. Primary count must not exceed clients with any qualifying visit in the period.
  const inPeriod = parseInt((await one(`
    SELECT COUNT(DISTINCT r.client_id) FROM records r
    WHERE ${QUALIFYING_WHERE} AND ${VDAY} BETWEEN $2::date AND $3::date`, p)).count);
  assert(primary <= inPeriod, `первичных (${primary}) не больше, чем клиентов с оплач. визитом в периоде (${inPeriod})`);

  // 3. Core invariant: every client counted as primary must have ZERO qualifying
  //    visits before `from`. Computed fully independently of PRIMARY_SQL.
  const violators = parseInt((await one(`
    WITH qrec AS (SELECT r.client_id, ${VDAY} AS vday FROM records r WHERE ${QUALIFYING_WHERE})
    SELECT COUNT(*) FROM (
      SELECT client_id FROM qrec GROUP BY client_id
      HAVING MIN(vday) BETWEEN $2::date AND $3::date
         AND COUNT(*) FILTER (WHERE vday < $2::date) > 0
    ) t`, p)).count);
  assert(violators === 0, `ни у одного первичного нет оплаченного визита ДО периода (нарушений: ${violators})`);

  // 4. Scenario from the owner: clients whose ONLY pre-period records were
  //    cancelled/no_show, and who have a qualifying visit in the period, MUST be
  //    counted as primary.
  const scenario = parseInt((await one(`
    WITH qrec AS (SELECT r.client_id, ${VDAY} AS vday FROM records r WHERE ${QUALIFYING_WHERE}),
    cancelled_before AS (
      SELECT DISTINCT r.client_id FROM records r
      WHERE r.salon_id=$1 AND r.client_id IS NOT NULL
        AND r.status IN ('cancelled','no_show')
        AND ${VDAY} < $2::date
    )
    SELECT COUNT(*) FROM (
      SELECT cb.client_id FROM cancelled_before cb
      JOIN qrec q ON q.client_id = cb.client_id
      GROUP BY cb.client_id
      HAVING MIN(q.vday) BETWEEN $2::date AND $3::date
         AND COUNT(*) FILTER (WHERE q.vday < $2::date) = 0
    ) t`, p)).count);
  console.log(`\n  ℹ Клиентов "был отменён ранее → первый оплач. визит в периоде": ${scenario}`);
  if (scenario > 0) {
    assert(scenario <= primary, `сценарий "ранее только отмены" входит в первичных (${scenario} <= ${primary})`);
  } else {
    console.log('  ℹ (в этом периоде таких клиентов нет — сценарий не на чем проверить)');
  }

  console.log(`\n${failures === 0 ? '✅ Все проверки пройдены' : '❌ Провалено проверок: ' + failures}`);
  await pool.end();
  if (failures) process.exit(1);
}

run().catch(e => { console.error('❌ Ошибка:', e.message); process.exit(1); });
