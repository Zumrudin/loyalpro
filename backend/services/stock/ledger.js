'use strict';
const m = require('./model');
const store = require('./store');
const logger = require('../../logger').createLogger('StockLedger');

/** Зеркало YClients → леджер. row — economics/goods-events.parseTransaction; opts {status, source, deletedAt}. */
async function ingestMirrored(salonId, row, opts) {
  // Удаление — раньше проверки вида: в payload delete может не быть type_id, а markMovementDeleted ищет по yclients_txn_id.
  if (opts.status === 'delete') { await store.markMovementDeleted(salonId, row.yclients_txn_id, opts.deletedAt || new Date()); return { deleted: true }; }
  const kind = m.kindByYcType(row.type_id);
  if (!kind) return { skipped: 'type' };
  const good = await store.goodByYcId(salonId, row.good_id);
  if (!good) { const { client, ...raw } = row.raw || {}; await store.addIngestPending(salonId, { ...row, raw }); logger.warn(`salon=${salonId}: товар ${row.good_id} неизвестен каталогу — строка ${row.yclients_txn_id} отложена`); return { pending: true }; }
  const storage = await store.ensureStorage(salonId, row.storage_id, row.raw && row.raw.storage && row.raw.storage.title);
  const ycClientId = row.raw && row.raw.client && Number(row.raw.client.id) > 0 ? Number(row.raw.client.id) : null;
  const clientId = ycClientId ? await store.clientIdByYc(salonId, ycClientId) : null;
  const { qtyBase, unitUnknown } = m.toBaseInfo({ kind, qty: row.amount, unitType: row.operation_unit_type, unitEquals: good.unit_equals, costPerUnit: row.cost_per_unit, cost: row.cost });
  const doc = await store.upsertMirrorDocument(salonId, { kind, ycDocumentId: row.document_id, storageId: storage.id, docDate: row.create_date, recordId: row.record_id, masterStaffYcId: row.master_id, clientId, ycClientId, comment: null }); // raw.comment YClients — свободный текст с именами клиентов, в документ не копируем (PII)
  await store.upsertMovement(salonId, { documentId: doc.id, goodRowId: good.id, storageId: storage.id, qty: row.amount, unitType: row.operation_unit_type, qtyBase, costPerUnit: row.cost_per_unit, discount: row.discount, cost: row.cost, recordId: row.record_id, serviceYcId: row.service_id, masterStaffYcId: row.master_id, ycTxnId: row.yclients_txn_id, source: opts.source, occurredAt: row.create_date, comment: unitUnknown ? 'unit_unknown' : null });
  return { ingested: true };
}

/** Наш документ → движения (внутри транзакции вызывающего: q — client.query). */
async function postDocument(q, salonId, doc, lines) {
  for (const l of lines) {
    const rows = doc.kind === 'move'
      ? [{ storageId: doc.storageId, qtyBase: -Math.abs(l.qtyBase) }, { storageId: doc.toStorageId, qtyBase: Math.abs(l.qtyBase) }]
      : [{ storageId: doc.storageId, qtyBase: l.qtyBase }];
    for (const r of rows) {
      await store.insertMovement(q, salonId, { documentId: doc.id, goodRowId: l.goodRowId, storageId: r.storageId, qty: l.qty, unitType: l.unitType, qtyBase: r.qtyBase, costPerUnit: l.costPerUnit, discount: l.discount, cost: l.cost, recordId: doc.recordId || null, serviceYcId: l.serviceYcId || null, masterStaffYcId: doc.masterStaffYcId || null, source: doc.source || 'loyalpro', occurredAt: doc.docDate, comment: l.comment || null });
    }
  }
}

function openingFromCatalog(goodRow) {
  const eq = Number(goodRow.unit_equals);
  return (Array.isArray(goodRow.stock) ? goodRow.stock : []).filter(s => s && s.storage_id).map(s => {
    const amount = Number(s.amount) || 0; const known = eq > 0;
    return { storageYcId: Number(s.storage_id), qtyBase: known ? amount * eq : amount, ycQtyBase: known ? amount * eq : amount, unitUnknown: !known };
  });
}
module.exports = { ingestMirrored, postDocument, openingFromCatalog };

async function drainIngestPending(salonId) {
  const rows = await store.pendingMirrorRows(salonId); let drained=0, failed=0;
  for (const row of rows) {
    try {
      const result=await ingestMirrored(salonId,row,{status:row.deleted_at?'delete':'update',source:row.source||'backfill',deletedAt:row.deleted_at});
      if (!result.pending) { await store.removeIngestPending(salonId,row.yclients_txn_id);drained++; }
    } catch (_) { failed++; }
  }
  return {drained,failed,pending:await store.pendingCount(salonId)};
}
module.exports.drainIngestPending=drainIngestPending;
