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

module.exports = { receiptUnitPrice, round4 };
