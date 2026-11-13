'use strict';
require('dotenv').config();
const { db, pool } = require('../db');
const { BALANCES_SQL } = require('../services/stock/store');
const { balanceCountsRow } = require('../services/stock/model');

// Отдельная проверка предиката той же строки по id, без округления дат JS.
const COUNTS_SQL = `SELECT EXISTS (
  SELECT 1 FROM stock_movements mv
  JOIN stock_documents d ON d.id = mv.document_id AND d.salon_id = mv.salon_id AND d.status = 'posted'
  LEFT JOIN stock_openings op ON op.salon_id = mv.salon_id AND op.good_row_id = mv.good_row_id AND op.storage_id = mv.storage_id
  WHERE mv.salon_id = $1 AND mv.id = $2 AND mv.deleted_at IS NULL
    AND (op.taken_at IS NULL OR mv.occurred_at > op.taken_at
         OR (mv.recorded_at > op.taken_at AND mv.source IN ('webhook','loyalpro','inventory')))
) AS counts`;
async function main() {
  const salonId = 1;
  const database = await db.one('SELECT current_database() AS name');
  if (database.name !== 'loyalpro_test') throw new Error('Скрипт разрешён только для дев-БД loyalpro_test');
  // Одна согласованная версия строк для JS и SQL.
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${BALANCES_SQL}`, [salonId]);
    console.log(plan.rows.map(r => r['QUERY PLAN']).join('\n'));
    const { rows } = await client.query(`SELECT mv.id, mv.occurred_at, mv.recorded_at, mv.source, mv.deleted_at, d.status, op.taken_at
      FROM stock_movements mv JOIN stock_documents d ON d.id = mv.document_id AND d.salon_id = mv.salon_id
      LEFT JOIN stock_openings op ON op.salon_id = mv.salon_id AND op.good_row_id = mv.good_row_id AND op.storage_id = mv.storage_id
      WHERE mv.salon_id = $1 ORDER BY random() LIMIT 200`, [salonId]);
    let mismatches = 0;
    for (const r of rows) {
      const js = !r.deleted_at && r.status === 'posted' && balanceCountsRow({ occurredAt: r.occurred_at, recordedAt: r.recorded_at, source: r.source }, { takenAt: r.taken_at });
      const sql = (await client.query(COUNTS_SQL, [salonId, r.id])).rows[0].counts;
      if (js !== sql) { console.error(`Расхождение движения ${r.id}: JS=${js}, SQL=${sql}`); mismatches++; }
    }
    console.log(`Инвариант: проверено ${rows.length}, расхождений ${mismatches}`);
    if (mismatches || rows.length < 200) process.exitCode = 1;
    await client.query('COMMIT');
  } finally { client.release(); }
}
if (require.main === module) main().catch(e => { console.error(`Ошибка проверки (${e.code || e.name})`); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { COUNTS_SQL, main };
