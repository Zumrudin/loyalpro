'use strict';

const { db } = require('../../db');
const { COUNTED_SQL } = require('./store');

// Reconstructed ledger balance, not an immutable historical snapshot. Never
// derive it from the filtered page: earlier rows outside that page still count.
// Before the opening snapshot there is no defensible baseline to reconstruct.
const VALUES_SQL = `SELECT target.id,
  CASE WHEN d.status = 'posted' AND target.deleted_at IS NULL
    AND target.comment IS DISTINCT FROM 'unit_unknown'
    AND NOT COALESCE(moved.unit_unknown, FALSE)
    AND (op.taken_at IS NULL OR target.occurred_at >= op.taken_at)
    AND (op.taken_at IS NULL OR target.source IN ('loyalpro','inventory')
      OR (target.recorded_at > op.taken_at AND target.source IN ('webhook','reconcile')))
    THEN COALESCE(op.qty_base, 0) + COALESCE(moved.qty_base, 0)
    ELSE NULL END AS balance_after,
  CASE WHEN target.comment = 'unit_unknown' THEN NULL
    WHEN d.kind = 'sale' THEN round(abs(target.qty_base) * receipt.cost / NULLIF(abs(receipt.qty_base), 0), 2)
    ELSE target.cost END AS cost_basis,
  CASE WHEN d.kind = 'sale' AND receipt.id IS NOT NULL THEN 'receipt'
    WHEN d.kind <> 'sale' AND target.cost IS NOT NULL THEN 'stored'
    ELSE NULL END AS cost_basis_source
FROM stock_movements target
JOIN stock_documents d ON d.id = target.document_id AND d.salon_id = target.salon_id
LEFT JOIN stock_openings op ON op.salon_id = target.salon_id
  AND op.good_row_id = target.good_row_id AND op.storage_id = target.storage_id
LEFT JOIN LATERAL (
  SELECT SUM(mv.qty_base) AS qty_base, BOOL_OR(mv.comment = 'unit_unknown') AS unit_unknown
  FROM stock_movements mv
  JOIN stock_documents md ON md.id = mv.document_id AND md.salon_id = mv.salon_id AND md.status = 'posted'
  WHERE mv.salon_id = target.salon_id AND mv.good_row_id = target.good_row_id
    AND mv.storage_id = target.storage_id AND mv.deleted_at IS NULL
    AND (mv.occurred_at, mv.id) <= (target.occurred_at, target.id)
    AND ${COUNTED_SQL}
) moved ON TRUE
LEFT JOIN LATERAL (
  SELECT rm.id, rm.qty_base, rm.cost
  FROM stock_movements rm
  JOIN stock_documents rd ON rd.id = rm.document_id AND rd.salon_id = rm.salon_id
  WHERE rm.salon_id = target.salon_id AND rm.good_row_id = target.good_row_id
    AND rd.kind = 'receipt' AND rd.status = 'posted' AND rm.deleted_at IS NULL
    AND rm.qty_base > 0 AND rm.cost >= 0 AND rm.comment IS DISTINCT FROM 'unit_unknown'
    AND (rm.occurred_at, rm.id) <= (target.occurred_at, target.id)
  ORDER BY rm.occurred_at DESC, rm.id DESC LIMIT 1
) receipt ON d.kind = 'sale'
WHERE target.salon_id = $1 AND target.id = ANY($2::bigint[])`;

async function enrichOperations(salonId, rows, query = db.any) {
  if (!rows.length) return rows;
  const values = await query(VALUES_SQL, [salonId, rows.map(r => r.id)]);
  const byId = new Map(values.map(r => [String(r.id), r]));
  return rows.map(row => {
    const v = byId.get(String(row.id));
    return { ...row, balance_after: v?.balance_after ?? null,
      cost_basis: v?.cost_basis ?? null, cost_basis_source: v?.cost_basis_source ?? null };
  });
}

module.exports = { VALUES_SQL, enrichOperations };
