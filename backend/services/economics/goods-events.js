'use strict';
// Чистый разбор товарной операции YClients. ОДИН разбор на два входа:
// payload.data вебхука goods_operations_* и строка GET /storages/transactions —
// поля совпадают, но API отдаёт числа строками ("cost_per_unit": "1.07").
// client.* (имя/телефон) выбрасывается — в goods_transactions PII не пишется.

const GOODS_RESOURCES = new Set([
  'goods_operations_consumable', 'goods_operations_receipt',
  'goods_operations_sale', 'goods_operations_stolen',
]);
const STATUSES = new Set(['create', 'update', 'delete']);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function idOf(v) { const o = obj(v); const n = o ? num(o.id) : null; return n && n > 0 ? n : null; }
function titleOf(v, max = 500) { const o = obj(v); return o && typeof o.title === 'string' && o.title ? o.title.slice(0, max) : null; }
function str(v, max) { return typeof v === 'string' && v ? v.slice(0, max) : null; }

// "2026-10-18T12:30:00+0400" → ISO UTC; "+0400" без двоеточия Date.parse понимает
// не везде, поэтому нормализуем смещение явно.
function parseDate(v) {
  if (typeof v !== 'string' || !v) return null;
  const s = v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Строка goods_transactions из data вебхука или строки API; null при битых полях. */
function parseTransaction(d) {
  if (!obj(d)) return null;
  const id = num(d.id);
  if (!id || id <= 0) return null;
  const amount = num(d.amount);
  if (amount === null) return null;
  const recordId = num(d.record_id);
  const unit = obj(d.unit);
  const { client, ...raw } = d; // eslint-disable-line no-unused-vars
  return {
    yclients_txn_id: id,
    document_id: num(d.document_id),
    type_id: num(d.type_id),
    type_title: str(d.type, 100),
    good_id: idOf(d.good),
    good_title: titleOf(d.good),
    storage_id: idOf(d.storage),
    unit_title: unit ? (str(unit.short_title, 50) || str(unit.title, 50)) : null,
    operation_unit_type: num(d.operation_unit_type),
    amount,
    cost_per_unit: num(d.cost_per_unit),
    cost: num(d.cost),
    discount: num(d.discount),
    record_id: recordId && recordId > 0 ? recordId : null,
    service_id: idOf(d.service),
    service_title: titleOf(d.service),
    master_id: idOf(d.master),
    supplier_title: titleOf(d.supplier, 255),
    create_date: parseDate(d.create_date),
    last_change_date: parseDate(d.last_change_date),
    raw,
  };
}

/** { resource, status, row } или null (не наш ресурс / неизвестный статус / битые данные). */
function parseGoodsOperation(payload) {
  if (!obj(payload)) return null;
  const resource = payload.resource || payload.resource_type;
  if (!GOODS_RESOURCES.has(resource)) return null;
  const status = payload.status;
  if (!STATUSES.has(status)) return null;
  const row = parseTransaction(payload.data);
  if (!row) return null;
  return { resource, status, row };
}

module.exports = { parseGoodsOperation, parseTransaction, parseDate, GOODS_RESOURCES };
