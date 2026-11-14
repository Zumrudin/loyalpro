'use strict';
// Чистая модель склада (§8 спеки): без БД и сети. Количество — в базовой единице списания.
const { writeoffQty } = require('../economics/price');

const KINDS = ['receipt', 'writeoff', 'sale', 'move', 'inventory', 'consumable', 'opening'];
const ORIGINS = ['loyalpro', 'yclients'];
const YC_TYPE_BY_KIND = { sale: 1, consumable: 2, receipt: 3, writeoff: 4, move: 5 };
const KIND_BY_YC_TYPE = Object.fromEntries(Object.entries(YC_TYPE_BY_KIND).map(([k, v]) => [v, k]));
const INFLOW_KINDS = new Set(['receipt', 'opening']);
const PAY_METHODS = ['cash', 'card']; // бонусы — только на услуги (решение владельца 13.11.2026)

class StockError extends Error { constructor(message, status = 400, code = 'bad_request', extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); } }
const fail = (message, status, code, extra) => { throw new StockError(message, status, code, extra); };

const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round4 = x => Math.round(x * 10000) / 10000;
const kop = x => Math.round(Number(x) * 100);

function signFor(kind) { return INFLOW_KINDS.has(kind) ? 1 : -1; }
function kindByYcType(typeId) { return KIND_BY_YC_TYPE[Number(typeId)] || null; }

/** Количество в базовой единице со знаком вида. Тип 2 — через общий writeoffQty (готча ед. продажи при типе 2). */
function toBaseInfo({ kind, qty, unitType, unitEquals, costPerUnit, cost }) {
  const q = Math.abs(Number(qty) || 0); const eq = num(unitEquals); const sign = signFor(kind);
  if (Number(unitType) === 2) return { qtyBase: round4(sign * writeoffQty({ amount: q, cost_per_unit: costPerUnit, cost }, eq)), unitUnknown: false };
  if (!(eq > 0)) return { qtyBase: round4(sign * q), unitUnknown: true };
  return { qtyBase: round4(sign * q * eq), unitUnknown: false };
}
const toBase = args => toBaseInfo(args).qtyBase;

/** Обратно: ед. продажи (floor) и остаток в базовых — для «2 шт + 150 мл». */
function fromBase(qtyBase, unitEquals) {
  const b = Number(qtyBase) || 0; const eq = num(unitEquals);
  if (!(eq > 0) || eq === 1) return { saleUnits: round4(b), remainderBase: 0 };
  const saleUnits = Math.floor(b / eq);
  return { saleUnits, remainderBase: round4(b - saleUnits * eq) };
}

/** Валидация документа формы. ctx: {storages:[{id,forService,forSale}], goods: Map<rowId,{stockActive,unitEquals}>} */
function validateDocument(body, ctx) {
  const errors = [], warnings = []; const b = body || {};
  if (!['receipt', 'writeoff', 'move', 'sale'].includes(b.kind)) errors.push('Неизвестный вид документа.');
  const storage = (ctx.storages || []).find(s => Number(s.id) === Number(b.storageId));
  if (!storage) errors.push('Склад не найден.');
  const docDate = b.docDate ? new Date(b.docDate) : null;
  if (!docDate || Number.isNaN(docDate.getTime())) errors.push('Дата документа некорректна.');
  if (b.kind === 'move') {
    const to = (ctx.storages || []).find(s => Number(s.id) === Number(b.toStorageId));
    if (!to) errors.push('Склад-получатель не найден.');
    else if (storage && Number(to.id) === Number(storage.id)) errors.push('Перемещение требует разные склады.');
  }
  if (b.kind === 'sale' && !(Number(b.clientId) > 0) && !b.phone) errors.push('Укажите клиента.');
  if (storage && b.kind === 'sale' && storage.forSale === false && storage.forService) warnings.push('Склад «не для продаж» — проверьте выбор.');
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) errors.push('Добавьте хотя бы одну строку.');
  const normLines = [];
  lines.forEach((l, i) => {
    const n = i + 1; const good = ctx.goods && ctx.goods.get(Number(l.goodRowId));
    if (!good) { errors.push(`Строка ${n}: товар не найден.`); return; }
    if (good.stockActive === false) errors.push(`Строка ${n}: товар неактивен.`);
    const qty = num(l.qty); if (!(qty > 0)) errors.push(`Строка ${n}: количество должно быть больше нуля.`);
    const unitType = Number(l.unitType); if (![1, 2].includes(unitType)) errors.push(`Строка ${n}: единица — продажи (1) или списания (2).`);
    const cpu = l.costPerUnit === undefined || l.costPerUnit === null || l.costPerUnit === '' ? 0 : num(l.costPerUnit);
    if (!(cpu >= 0)) errors.push(`Строка ${n}: цена не может быть отрицательной.`);
    const disc = l.discount === undefined || l.discount === null || l.discount === '' ? 0 : num(l.discount);
    if (!(disc >= 0 && disc <= 100)) errors.push(`Строка ${n}: скидка от 0 до 100 %.`);
    const cost = kop((qty || 0) * (cpu || 0) * (1 - (disc || 0) / 100)) / 100;
    const { qtyBase, unitUnknown } = toBaseInfo({ kind: b.kind, qty: qty || 0, unitType, unitEquals: good.unitEquals, costPerUnit: cpu, cost });
    normLines.push({ goodRowId: Number(l.goodRowId), qty, unitType, costPerUnit: cpu, discount: disc, cost, qtyBase, unitUnknown, comment: typeof l.comment === 'string' ? l.comment.slice(0, 500) : null });
  });
  const totalCost = normLines.reduce((s, l) => s + kop(l.cost), 0) / 100;
  if (b.kind === 'sale' && !errors.length && totalCost <= 0 && b.gift !== true) errors.push('Итог продажи равен нулю — отметьте «подарок» или укажите цену.');
  return { ok: !errors.length, errors, warnings, normalized: { kind: b.kind, storageId: storage ? Number(storage.id) : null, toStorageId: b.kind === 'move' ? Number(b.toStorageId) : null, docDate, comment: typeof b.comment === 'string' ? b.comment.slice(0, 1000) : '', lines: normLines, totalCost } };
}

/** Оплаты продажи: методы cash|card, сумма = итогу (в копейках). */
function validateSalePayments(payments, total, opts = {}) {
  const errors = []; const list = Array.isArray(payments) ? payments : [];
  if (opts.gift === true) { if (list.length) errors.push('У подарка не бывает оплат.'); return { ok: !errors.length, errors }; }
  let sum = 0;
  for (const p of list) {
    if (!PAY_METHODS.includes(p && p.method)) { errors.push('Способ оплаты: наличные или карта (бонусы — только на услуги).'); continue; }
    const a = num(p.amount); if (!(a > 0)) { errors.push('Сумма оплаты должна быть больше нуля.'); continue; }
    sum += kop(a);
  }
  if (!errors.length && sum !== kop(total)) errors.push(`Сумма оплат не совпадает с итогом (${(sum / 100).toFixed(2)} ≠ ${Number(total).toFixed(2)}).`);
  return { ok: !errors.length, errors };
}

/** Целевой состав (положительные qtyBase) против факта (отрицательные) → движения-дельты в знаке движения. */
function consumableDelta(target, actual) {
  const want = new Map(); for (const t of target || []) want.set(Number(t.goodRowId), (want.get(Number(t.goodRowId)) || 0) + Math.abs(Number(t.qtyBase) || 0));
  const have = new Map(); for (const a of actual || []) have.set(Number(a.goodRowId), (have.get(Number(a.goodRowId)) || 0) + Math.abs(Number(a.qtyBase) || 0));
  const ids = [...new Set([...want.keys(), ...have.keys()])].sort((a, b) => a - b);
  return ids.map(id => ({ goodRowId: id, qtyBase: round4(-((want.get(id) || 0) - (have.get(id) || 0))) })).filter(d => d.qtyBase !== 0);
}

function inventoryDiff({ expectedBase, counted, countedUnitType, unitEquals }) {
  const c = Math.abs(Number(counted) || 0); const eq = num(unitEquals);
  const countedBase = Number(countedUnitType) === 1 && eq > 0 ? round4(c * eq) : round4(c);
  return { countedBase, diffBase: round4(countedBase - (Number(expectedBase) || 0)) };
}

/** §6.3: считается ли строка в остаток при данном входящем остатке. */
function balanceCountsRow(row, opening) {
  if (!opening || !opening.takenAt) return true;
  if (['loyalpro', 'inventory'].includes(row.source)) return true;            // локальное — YClients его не видел
  const t = new Date(opening.takenAt).getTime();
  return new Date(row.recordedAt).getTime() > t && ['webhook', 'reconcile'].includes(row.source);
}

module.exports = { KINDS, ORIGINS, YC_TYPE_BY_KIND, PAY_METHODS, StockError, fail, signFor, kindByYcType, toBase, toBaseInfo, fromBase, validateDocument, validateSalePayments, consumableDelta, inventoryDiff, balanceCountsRow, kop };
