'use strict';
require('dotenv').config();
const { db, pool } = require('../db');
const { ingestMirrored } = require('../services/stock/ledger');
const { kindByYcType } = require('../services/stock/model');

// Колонки уже нормализованы общим parseTransaction; id здесь — внутренний,
// поэтому восстанавливаем именно его результат, не подменяем yclients_txn_id.
function mirrorRow(r) {
  return { yclients_txn_id: r.yclients_txn_id, document_id: r.document_id, type_id: r.type_id,
    good_id: r.good_id, storage_id: r.storage_id, operation_unit_type: r.operation_unit_type,
    amount: r.amount, cost_per_unit: r.cost_per_unit, cost: r.cost, discount: r.discount,
    record_id: r.record_id, service_id: r.service_id, master_id: r.master_id,
    create_date: r.create_date, raw: r.raw || {} };
}
async function main() {
  const salonId = Number((process.argv.find(a => a.startsWith('--salon=')) || '').split('=')[1]);
  if (!Number.isSafeInteger(salonId) || salonId <= 0) throw new Error('Укажите --salon=<id>');
  const write = process.argv.includes('--write');
  const database = await db.one('SELECT current_database() AS name');
  if (database.name !== 'loyalpro_test') throw new Error('Скрипт разрешён только для дев-БД loyalpro_test');
  const known = new Set((await db.any('SELECT yclients_good_id FROM yclients_goods_catalog WHERE salon_id = $1 AND yclients_good_id IS NOT NULL', [salonId])).map(g => String(g.yclients_good_id)));
  const counts = { ingested: 0, pending: 0, deleted: 0, skipped: 0 };
  let lastId = 0;
  for (;;) {
    const rows = await db.any('SELECT * FROM goods_transactions WHERE salon_id = $1 AND id > $2 ORDER BY id LIMIT 500', [salonId, lastId]);
    if (!rows.length) break;
    for (const r of rows) {
      const row = mirrorRow(r);
      const result = write ? await ingestMirrored(salonId, row, { status: r.deleted_at ? 'delete' : 'update', source: 'backfill', deletedAt: r.deleted_at })
        : !kindByYcType(row.type_id) ? { skipped: true } : r.deleted_at ? { deleted: true } : known.has(String(row.good_id)) ? { ingested: true } : { pending: true };
      counts[Object.keys(counts).find(k => result[k])]++;
    }
    lastId = rows[rows.length - 1].id;
  }
  console.log(`${write ? 'Переливка' : 'Сухой разбор'}: ${JSON.stringify(counts)}`);
  return counts;
}
if (require.main === module) main().catch(e => { console.error(`Ошибка переливки (${e.code || e.name})`); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { mirrorRow, main };
