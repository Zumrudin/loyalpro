'use strict';

// Построчный журнал склада. Фильтры применяются в PostgreSQL до пагинации;
// salon_id приходит только из JWT и присутствует во всех tenant-owned JOIN.
const { db } = require('../../db');
const { enrichOperations } = require('./operation-values');

const PAYMENT_STATUS_SQL = `CASE
  WHEN d.kind <> 'sale' THEN 'not_applicable'
  WHEN d.total_cost IS NULL THEN 'unknown'
  WHEN d.total_cost = 0 THEN 'not_applicable'
  WHEN pay.document_id IS NULL AND d.origin = 'yclients' THEN 'unknown'
  WHEN pay.document_id IS NULL THEN 'unpaid'
  WHEN pay.confirmed_amount >= d.total_cost THEN 'paid'
  WHEN pay.confirmed_amount > 0 THEN 'partial'
  WHEN pay.pending_count > 0 THEN 'pending'
  WHEN pay.failed_count > 0 THEN 'failed'
  WHEN pay.cancelled_count > 0 THEN 'cancelled'
  ELSE 'unpaid'
END`;

const PAYMENT_CTE = `payments AS (
  SELECT stock_document_id AS document_id,
    COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_amount,
    COUNT(*) FILTER (WHERE status IN ('queued', 'sending')) AS pending_count,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
    COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count
  FROM finance_operations
  WHERE salon_id = $1 AND stock_document_id IS NOT NULL
  GROUP BY stock_document_id
)`;

const like = value => `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;

function buildOperationsSql(f = {}, { count = false } = {}) {
  const params = [f.salonId];
  const where = [];
  const add = (value, expression) => { params.push(value); where.push(expression.replace('?', `$${params.length}`)); };
  if (f.from) add(f.from, "m.occurred_at >= (?::date)::timestamp AT TIME ZONE 'Europe/Moscow'");
  if (f.to) add(f.to, "m.occurred_at < ((?::date) + 1)::timestamp AT TIME ZONE 'Europe/Moscow'");
  if (f.kind) add(f.kind, 'd.kind = ?');
  if (f.origin) add(f.origin, 'd.origin = ?');
  if (f.status) add(f.status, 'd.status = ?');
  if (f.storage) add(f.storage, 'm.storage_id = ?');
  if (f.search) add(like(f.search), `(g.title ILIKE ? ESCAPE '\\' OR COALESCE(g.article, '') ILIKE $${params.length + 1} ESCAPE '\\')`);
  if (f.counterparty) add(like(f.counterparty), `(CASE WHEN d.kind = 'move' AND m.storage_id = d.storage_id THEN dst.title
    WHEN d.kind = 'move' THEN src.title ELSE COALESCE(sup.title, c.name) END) ILIKE ? ESCAPE '\\'`);
  if (f.clientSearch) add(like(f.clientSearch), `(COALESCE(c.name, '') ILIKE ? ESCAPE '\\' OR COALESCE(c.phone, '') ILIKE $${params.length + 1} ESCAPE '\\')`);
  if (f.documentNumber) add(like(f.documentNumber), `(d.id::text ILIKE ? ESCAPE '\\'
    OR COALESCE(d.yclients_document_id::text, '') ILIKE $${params.length + 1} ESCAPE '\\')`);
  if (f.service) add(f.service, 'm.service_yc_id = ?');

  const baseWhere = where.length ? ` AND ${where.join(' AND ')}` : '';
  let paymentWhere = '';
  if (f.paymentStatus) {
    params.push(f.paymentStatus);
    paymentWhere = `WHERE payment_status = $${params.length}`;
  }
  const ctes = `WITH ${PAYMENT_CTE}, operation_rows AS (
    SELECT m.id, m.document_id,
      COALESCE(d.yclients_document_id::text, d.id::text) AS document_number,
      d.origin, d.status, d.kind, m.occurred_at,
      m.good_row_id, g.title AS good_title, g.article,
      m.storage_id, st.title AS storage_title,
      CASE WHEN m.comment = 'unit_unknown' THEN 'Неизвестны единицы измерения'
        ELSE COALESCE(m.comment, d.comment) END AS comment,
      CASE WHEN d.kind = 'move' AND m.storage_id = d.storage_id THEN dst.title
        WHEN d.kind = 'move' THEN src.title ELSE COALESCE(sup.title, c.name) END AS counterparty_name,
      c.id AS client_id, COALESCE(m.record_id, d.record_id) AS record_id,
      r.visit_datetime AS visit_at, m.service_yc_id,
      CASE WHEN m.comment = 'unit_unknown' THEN NULL ELSE m.qty_base END AS qty_base,
      CASE WHEN m.comment IS DISTINCT FROM 'unit_unknown' AND g.unit_equals > 0
        THEN m.qty_base / g.unit_equals ELSE NULL END AS qty_pack,
      g.unit AS unit_title, g.service_unit AS service_unit_title,
      m.cost, m.deleted_at, NULL::numeric AS cost_basis, NULL::numeric AS balance_after,
      ${PAYMENT_STATUS_SQL} AS payment_status
    FROM stock_movements m
    JOIN stock_documents d ON d.id = m.document_id AND d.salon_id = m.salon_id
    JOIN yclients_goods_catalog g ON g.id = m.good_row_id AND g.salon_id = m.salon_id
    JOIN stock_storages st ON st.id = m.storage_id AND st.salon_id = m.salon_id
    LEFT JOIN stock_storages src ON src.id = d.storage_id AND src.salon_id = d.salon_id
    LEFT JOIN stock_storages dst ON dst.id = d.to_storage_id AND dst.salon_id = d.salon_id
    LEFT JOIN stock_suppliers sup ON sup.id = d.supplier_id AND sup.salon_id = d.salon_id
    LEFT JOIN clients c ON c.salon_id = d.salon_id AND
      ((d.client_id IS NOT NULL AND c.id = d.client_id) OR
       (d.client_id IS NULL AND d.yclients_client_id IS NOT NULL AND c.yclients_client_id = d.yclients_client_id))
    LEFT JOIN records r ON r.salon_id = d.salon_id
      AND r.yclients_record_id = COALESCE(m.record_id, d.record_id)
    LEFT JOIN payments pay ON pay.document_id = d.id
    WHERE m.salon_id = $1${baseWhere}
  )`;
  if (count) return { sql: `${ctes} SELECT COUNT(*)::int AS total FROM operation_rows ${paymentWhere}`, params };
  const limit = Math.min(Math.max(Number(f.limit) || 25, 1), 100);
  const page = Math.max(Number(f.page) || 1, 1);
  params.push(limit, (page - 1) * limit);
  return { sql: `${ctes}
    SELECT operation_rows.*, COUNT(*) OVER()::int AS total
    FROM operation_rows ${paymentWhere}
    ORDER BY occurred_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params };
}

const rowsFrom = result => Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : []);
const queryAny = query => async (sql, params) => rowsFrom(await query(sql, params));

async function listOperations(salonId, filters = {}, { query = db.any } = {}) {
  const f = { ...filters, salonId };
  const any = queryAny(query);
  const built = buildOperationsSql(f);
  const raw = await any(built.sql, built.params);
  let total = raw.length ? Number(raw[0].total) : 0;
  if (!raw.length) {
    const counted = buildOperationsSql(f, { count: true });
    const rows = await any(counted.sql, counted.params);
    total = Number(rows[0]?.total) || 0;
  }
  const operations = raw.map(({ total: _total, ...row }) => row);
  return {
    operations: await enrichOperations(salonId, operations, any),
    total,
    page: Math.max(Number(filters.page) || 1, 1),
    limit: Math.min(Math.max(Number(filters.limit) || 25, 1), 100),
  };
}

const OPERATION_SERVICES_SQL = `SELECT DISTINCT m.service_yc_id AS id,
  COALESCE(
    (SELECT sc.title FROM service_catalog sc
      WHERE sc.salon_id = m.salon_id
        AND (sc.yclients_id = m.service_yc_id OR sc.economics_yc_id = m.service_yc_id)
      ORDER BY sc.active DESC, sc.id LIMIT 1),
    (SELECT item->>'title' FROM records r
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.services) = 'array' THEN r.services ELSE '[]'::jsonb END) item
      WHERE r.salon_id = m.salon_id AND r.yclients_record_id = COALESCE(m.record_id, d.record_id)
        AND item->>'id' = m.service_yc_id::text LIMIT 1)
  ) AS title
FROM stock_movements m
JOIN stock_documents d ON d.id = m.document_id AND d.salon_id = m.salon_id
WHERE m.salon_id = $1 AND m.service_yc_id IS NOT NULL
ORDER BY title NULLS LAST, id`;

async function listOperationServices(salonId, query = db.any) {
  return queryAny(query)(OPERATION_SERVICES_SQL, [salonId]);
}

module.exports = { PAYMENT_STATUS_SQL, OPERATION_SERVICES_SQL, buildOperationsSql,
  listOperations, listOperationServices, queryAny };
