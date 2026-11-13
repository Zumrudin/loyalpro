'use strict';
const { pool } = require('../../db');
const store = require('./store');
const ledger = require('./ledger');
const m = require('./model');
const { ycGet } = require('../yclients');
const { parseCatalogGood } = require('../economics/sync');

const validId = v => (typeof v === 'number' || typeof v === 'string') && Number.isSafeInteger(Number(v)) && Number(v) > 0;
const validation = errors => m.fail(errors[0], 400, 'validation', { errors });
const checkId = v => { if (!validId(v)) validation(['Некорректный id.']); return Number(v); };
const categoryMatches = (g, category) => g && (g.local_category === String(category) ||
  (Array.isArray(g.category_path) && g.category_path.some(n => String(n.id) === String(category))));
async function transaction(salonId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client.query.bind(client));
    await client.query('COMMIT');
    client.release();
    store.invalidateBalances(salonId);
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { client.release(rollbackErr); throw e; }
    client.release();
    throw e;
  }
}
async function document(salonId, id, q, inventory = false) {
  const d = await store.documentById(salonId, checkId(id), q);
  if (!d || (inventory && d.kind !== 'inventory')) m.fail('Документ не найден.', 404, 'not_found');
  return d;
}
async function detail(salonId, id, inventory = false) {
  const d = await document(salonId, id, undefined, inventory);
  return { ...d, lines: await (inventory ? store.listInventoryLines(salonId, id) : store.listMovementsByDocument(salonId, id)) };
}
async function activeStorage(salonId, id) {
  const s = await store.storageById(salonId, checkId(id));
  if (!s || !s.is_active) validation(['Склад не найден или неактивен.']);
  return s;
}
async function create(salonId, userId, body) {
  const b = body || {};
  const [storages, goods] = await Promise.all([store.listStorages(salonId), store.listGoods(salonId)]);
  const result = m.validateDocument({ ...b, lines: Array.isArray(b.lines) ? b.lines.map(l => l || {}) : b.lines }, {
    storages: storages.filter(s => s.is_active).map(s => ({ id: s.id, forService: s.for_service, forSale: s.for_sale })),
    goods: new Map(goods.map(g => [Number(g.id), { stockActive: g.stock_active, unitEquals: g.unit_equals }])) });
  if (!['receipt', 'writeoff', 'move'].includes(b.kind)) result.errors.push('Вид документа: приход, списание или перемещение.');
  if (!validId(b.storageId) || (b.kind === 'move' && !validId(b.toStorageId))) result.errors.push('Некорректный id склада.');
  if (b.supplierId != null) {
    if (!validId(b.supplierId) || !(await store.listSuppliers(salonId)).some(s => Number(s.id) === Number(b.supplierId))) result.errors.push('Поставщик не найден.');
  }
  if (result.errors.length) validation(result.errors);
  const { lines, ...normalized } = result.normalized;
  return transaction(salonId, async q => {
    const input = { ...normalized, supplierId: b.supplierId == null ? null : Number(b.supplierId), origin: 'loyalpro', status: 'posted', createdBy: userId };
    const d = await store.insertDocument(q, salonId, input);
    await ledger.postDocument(q, salonId, { ...input, ...d }, lines);
    return { ...d, lines, warnings: result.warnings };
  });
}
async function cancel(salonId, userId, id, reason) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) validation(['Причина: от 1 до 500 символов.']);
  await transaction(salonId, async q => {
    const d = await document(salonId, id, q);
    if (d.origin === 'yclients') m.fail('Зеркальный документ нельзя отменить.', 409, 'mirror');
    if (d.status === 'cancelled') m.fail('Документ уже отменён.', 409, 'already_cancelled');
    // Opening меняет снимок, sale — деньги: обычная отмена движений для них недостаточна.
    if (!['receipt', 'writeoff', 'move', 'inventory'].includes(d.kind)) m.fail('Для этого вида нужна отдельная отмена.', 409, 'kind');
    await store.cancelDocument(q, salonId, Number(id), reason.trim());
    await store.softDeleteDocumentMovements(q, salonId, Number(id));
  });
  return detail(salonId, id);
}
async function inventoryCreate(salonId, userId, body) {
  const b = body || {}; const storage = await activeStorage(salonId, b.storageId);
  if (b.categoryPathPrefix != null) checkId(b.categoryPathPrefix);
  if (b.localCategory != null && (typeof b.localCategory !== 'string' || !b.localCategory.trim())) validation(['Некорректная категория.']);
  const goods = await store.listGoods(salonId);
  const byId = new Map(goods.map(g => [String(g.id), g]));
  const id = await transaction(salonId, async q => {
    const rows = await store.balances(salonId, { storageId: storage.id }, q);
    const { rows: [{ now }] } = await q('SELECT NOW() AS now');
    const d = await store.insertDocument(q, salonId, { kind: 'inventory', origin: 'loyalpro', status: 'draft', storageId: storage.id, docDate: now, createdBy: userId });
    const lines = rows.filter(r => {
      const g = byId.get(String(r.good_row_id));
      return (b.categoryPathPrefix == null || (g && Array.isArray(g.category_path) && g.category_path.some(n => String(n.id) === String(b.categoryPathPrefix)))) &&
        (b.localCategory == null || (g && g.local_category === b.localCategory));
    }).map(r => ({ goodRowId: Number(r.good_row_id), storageId: storage.id, expectedBase: Number(r.qty_base) }));
    await store.insertInventoryLines(q, salonId, d.id, lines);
    return d.id;
  });
  return detail(salonId, id, true);
}
const draft = d => { if (d.status !== 'draft') m.fail('Инвентаризация уже проведена или отменена.', 409, 'not_draft'); };
async function inventorySetLines(salonId, id, lines) {
  await transaction(salonId, async q => {
    const d = await document(salonId, id, q, true); draft(d);
    if (!Array.isArray(lines)) validation(['Ожидается список строк.']);
    const existing = new Map((await store.listInventoryLines(salonId, id, q)).map(l => [Number(l.good_row_id), l]));
    const seen = new Set();
    const updates = lines.map(l => {
      if (!l || !validId(l.goodRowId) || !existing.has(Number(l.goodRowId)) || seen.has(Number(l.goodRowId))) validation(['Строка не найдена в документе или повторяется.']);
      seen.add(Number(l.goodRowId));
      if (l.counted === null || l.counted === '' || !['number', 'string'].includes(typeof l.counted) || !Number.isFinite(Number(l.counted)) || Number(l.counted) < 0 || ![1, 2].includes(Number(l.countedUnitType))) validation(['Некорректное количество или единица.']);
      const old = existing.get(Number(l.goodRowId));
      return { goodRowId: Number(l.goodRowId), counted: Number(l.counted), countedUnitType: Number(l.countedUnitType), expectedBase: Number(old.expected_base),
        ...m.inventoryDiff({ expectedBase: old.expected_base, counted: l.counted, countedUnitType: l.countedUnitType, unitEquals: old.unit_equals }) };
    });
    for (const l of updates) await store.updateInventoryLine(q, salonId, Number(id), l);
  });
  return detail(salonId, id, true);
}
async function inventoryPost(salonId, userId, id) {
  await transaction(salonId, async q => {
    const d = await document(salonId, id, q, true); draft(d);
    const rows = await store.balances(salonId, { storageId: d.storage_id }, q);
    const expected = new Map(rows.map(r => [String(r.good_row_id), Number(r.qty_base)]));
    const lines = await store.listInventoryLines(salonId, id, q);
    const { rows: [{ now }] } = await q('SELECT NOW() AS now');
    for (const l of lines) {
      if (l.counted_base == null) continue;
      const expectedBase = expected.get(String(l.good_row_id)) || 0;
      const diffBase = Math.round((Number(l.counted_base) - expectedBase) * 10000) / 10000;
      await store.updateInventoryLine(q, salonId, Number(id), { goodRowId: l.good_row_id, expectedBase, counted: l.counted, countedUnitType: l.counted_unit_type, countedBase: l.counted_base, diffBase });
      if (diffBase !== 0) await store.insertMovement(q, salonId, { documentId: d.id, goodRowId: l.good_row_id, storageId: d.storage_id,
        qty: Math.abs(diffBase), unitType: 2, qtyBase: diffBase, source: 'inventory', occurredAt: now });
    }
    await store.postInventory(q, salonId, Number(id));
  });
  return detail(salonId, id, true);
}
async function openingReset(salon, userId, body) {
  const b = body || {}; const goodRowId = checkId(b.goodRowId); const storageId = checkId(b.storageId);
  if (typeof b.note !== 'string' || !b.note.trim() || b.note.length > 1000) validation(['Укажите причину пересчёта (до 1000 символов).']);
  const good = await store.goodById(salon.id, goodRowId);
  if (!good) m.fail('Товар не найден.', 404, 'not_found');
  if (good.yclients_good_id == null) m.fail('У локального товара нет показания YClients.', 409, 'local_good');
  const storage = await activeStorage(salon.id, storageId);
  if (storage.yclients_storage_id == null) m.fail('У склада нет показания YClients.', 409, 'local_storage');
  const settings = await store.getSettings(salon.id);
  if (!settings || !settings.enabled) m.fail('Входящий остаток ещё не снят (scripts/stock-opening.js).', 409, 'not_enabled');
  let parsed;
  try { parsed = parseCatalogGood(await ycGet(salon, `/goods/${salon.yclients_company_id}/${good.yclients_good_id}`)); }
  catch (_) { m.fail('unavailable', 502, 'unavailable'); }
  const stock = parsed && parsed.stock.find(s => Number(s.storage_id) === Number(storage.yclients_storage_id));
  if (!parsed || Number(parsed.good_id) !== Number(good.yclients_good_id) || !(parsed.unit_equals > 0) || !stock || stock.amount == null) m.fail('unavailable', 502, 'unavailable');
  const qtyBase = Math.round(stock.amount * parsed.unit_equals * 10000) / 10000;
  return transaction(salon.id, async q => {
    const { rows: [{ now }] } = await q('SELECT NOW() AS now');
    await store.insertOpening(q, salon.id, { goodRowId, storageId, qtyBase, ycQtyBase: qtyBase, takenAt: now, note: b.note.trim(), createdBy: userId });
    const d = await store.insertDocument(q, salon.id, { kind: 'opening', origin: 'loyalpro', status: 'posted', storageId, docDate: now, postedAt: now, comment: b.note.trim(), createdBy: userId });
    const line = { documentId: d.id, goodRowId, storageId, qty: qtyBase, unitType: 2, qtyBase, source: 'opening', occurredAt: now, comment: b.note.trim() };
    await store.insertMovement(q, salon.id, line);
    return { ...d, lines: [line] };
  });
}
module.exports = { create, cancel, inventoryCreate, inventorySetLines, inventoryPost, openingReset, detail, categoryMatches };
