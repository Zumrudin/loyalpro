'use strict';
// Цена единицы материала. Полное правило (§3.2 спеки) — unitPriceAsOf, ниже.
// receiptUnitPrice: цена ЕДИНИЦЫ СПИСАНИЯ по строке прихода. Приход идёт в единице
// продажи (operation_unit_type 1: флакон, упаковка), списание — в единице списания
// (мл, ед.); пересчёт через unit_equals каталога. cost прихода уже с учётом скидки
// поставщика (10 шт по 11 630 ₽ со скидкой 5 % → cost 110 485 → 11 048,5 ₽/шт).
function round4(x) { return Math.round(x * 10000) / 10000; }

function receiptUnitPrice(txn, unitEquals) {
  if (!txn) return null;
  const amount = Math.abs(Number(txn.amount));
  const cost = Number(txn.cost);
  if (!(amount > 0) || !Number.isFinite(cost) || cost < 0) return null;
  let per = cost / amount;
  const eq = Number(unitEquals);
  if (Number(txn.operation_unit_type) === 1 && eq > 0) per = per / eq;
  return round4(per);
}


const MSK = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' });
/** 'YYYY-MM-DD' по Москве из Date/ISO/'YYYY-MM-DD'; null для пустого. */
function mskDay(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? MSK.format(d) : null;
}

/**
 * Правило §3.2: 1) последний приход <= date (cost/amount/unit_equals), 2) ручная
 * цена goods_price_overrides, 3) unit_actual_cost каталога, 4) 0 + source 'none'
 * (в отчёте — флаг «товар без цены»).
 */
function unitPriceAsOf({ receipts = [], override = null, catalogRow = null, date }) {
  const day = mskDay(date);
  const eq = catalogRow ? catalogRow.unit_equals : null;
  const cands = (receipts || [])
    .filter(r => r && Number(r.amount) > 0 && (!day || mskDay(r.create_date) <= day))
    .sort((a, b) => String(mskDay(b.create_date)).localeCompare(String(mskDay(a.create_date))));
  for (const r of cands) {
    const p = receiptUnitPrice(r, eq);
    if (p !== null && p > 0) return { price: p, source: 'receipt', at: r.create_date };
  }
  const ov = override && Number(override.unit_price);
  if (ov > 0) return { price: ov, source: 'override' };
  const uac = catalogRow && Number(catalogRow.unit_actual_cost);
  if (uac > 0) return { price: uac, source: 'catalog' };
  return { price: 0, source: 'none' };
}

module.exports = { receiptUnitPrice, unitPriceAsOf, mskDay, round4 };
