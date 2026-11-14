'use strict';
// Только GET YClients; запись снимка — исключительно в дев-БД.
require('dotenv').config();
const { db, pool, withTransaction } = require('../db');
const store = require('../services/stock/store');
const { openingFromCatalog } = require('../services/stock/ledger');
const { syncGoodsCatalog } = require('../services/economics/sync');

async function main() {
  const salonId = Number((process.argv.find(a => a.startsWith('--salon=')) || '').split('=')[1]);
  if (!Number.isSafeInteger(salonId) || salonId <= 0) throw new Error('Укажите --salon=<id>');
  const write = process.argv.includes('--write');
  const database = await db.one('SELECT current_database() AS name');
  if (database.name !== 'loyalpro_test') throw new Error('Скрипт разрешён только для дев-БД loyalpro_test');
  const settings = await db.one('SELECT enabled FROM stock_settings WHERE salon_id = $1', [salonId]);
  if (settings && settings.enabled) { console.error('Склад уже включён: повторный снимок запрещён'); process.exitCode = 2; return; }
  const salon = await db.one('SELECT * FROM salons WHERE id = $1', [salonId]);
  if (!salon) throw new Error('Салон не найден');
  const synced = await syncGoodsCatalog(salon);
  if (synced.pages >= require('../services/economics/sync').MAX_GOODS_PAGES) throw new Error('Каталог неполон: достигнут предел страниц');
  const goods = await db.any(`SELECT id, yclients_good_id, title, unit_equals, stock FROM yclients_goods_catalog
    WHERE salon_id = $1 AND yclients_good_id IS NOT NULL ORDER BY id`, [salonId]);
  const takenAt = new Date();
  const rows = goods.flatMap(g => openingFromCatalog(g).map(o => ({ ...o, goodRowId: g.id, title: g.title, ycGoodId: g.yclients_good_id, saleQty: o.qtyBase / (Number(g.unit_equals) > 0 ? Number(g.unit_equals) : 1) })));
  console.table(rows.map(r => ({ товар: `${r.ycGoodId} ${r.title}`, склад: r.storageYcId, qty_base: r.qtyBase, 'в ед. продажи': r.saleQty })));
  console.log(`ИТОГО строк: ${rows.length}; неизвестная единица: ${rows.filter(r => r.unitUnknown).length}`);
  if (!write) return;
  await withTransaction(async client => {
    const q = client.query.bind(client);
    await q('INSERT INTO stock_settings (salon_id) VALUES ($1) ON CONFLICT DO NOTHING', [salonId]);
    const locked = await q('SELECT enabled FROM stock_settings WHERE salon_id = $1 FOR UPDATE', [salonId]);
    if (locked.rows[0].enabled) { const error = new Error('Склад уже включён: повторный снимок запрещён'); error.exitCode = 2; throw error; }
    const doc = await store.insertDocument(q, salonId, { kind: 'opening', status: 'posted', docDate: takenAt, postedAt: takenAt });
    for (const r of rows) {
      const storage = await q(`INSERT INTO stock_storages (salon_id, yclients_storage_id, title)
        VALUES ($1, $2, $3) ON CONFLICT (salon_id, yclients_storage_id) WHERE yclients_storage_id IS NOT NULL
        DO UPDATE SET yclients_storage_id = EXCLUDED.yclients_storage_id RETURNING id`, [salonId, r.storageYcId, `Склад ${r.storageYcId}`]);
      const storageId = storage.rows[0].id;
      await store.insertOpening(q, salonId, { ...r, storageId, takenAt, note: r.unitUnknown ? 'unit_unknown' : null });
      await store.insertMovement(q, salonId, { documentId: doc.id, goodRowId: r.goodRowId, storageId,
        qty: r.saleQty, unitType: 1, qtyBase: r.qtyBase, source: 'opening', occurredAt: takenAt,
        comment: r.unitUnknown ? 'unit_unknown' : null });
    }
    await store.setEnabled(q, salonId, true);
  });
  store.invalidateBalances(salonId);
  console.log(`Снимок записан: ${rows.length} строк`);
}
if (require.main === module) main().catch(e => { console.error(`Ошибка снимка (${e.code || e.name})`); process.exitCode = e.exitCode || 1; }).finally(() => pool.end());
module.exports = { main };
