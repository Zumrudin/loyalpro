'use strict';
// IO-слой экономики процедур. SQL экспортируется ради живого EXPLAIN
// (scripts/economics-explain.js) — ГОТЧА проекта: EXPLAIN с литералами не
// ловит вывод типов параметров. Загрузчики отчёта — ниже (задача 11).
const { db } = require('../../db');
const { receiptUnitPrice } = require('./price');
const { createLogger } = require('../../logger');
const logger = createLogger('EconomicsStore');

const TXN_COLS = [
  'document_id', 'type_id', 'type_title', 'good_id', 'good_title', 'storage_id', 'unit_title',
  'operation_unit_type', 'amount', 'cost_per_unit', 'cost', 'discount', 'record_id', 'service_id',
  'service_title', 'master_id', 'supplier_title', 'create_date', 'last_change_date', 'raw',
];

/**
 * Апсерт строки goods_transactions. status 'delete' ставит deleted_at (строка
 * остаётся — форензика), create/update снимают deleted_at (сверка вернула живую).
 * @param {number} salonId
 * @param {object} row — результат goods-events.parseTransaction
 * @param {{status:'create'|'update'|'delete', source:'webhook'|'reconcile'|'backfill', deletedAt?:string}} opts
 */
async function upsertGoodsTransaction(salonId, row, opts) {
  const { status, source } = opts;
  const deletedAt = status === 'delete' ? (opts.deletedAt || null) : null;
  const vals = TXN_COLS.map(c => (c === 'raw' ? JSON.stringify(row.raw || {}) : (row[c] === undefined ? null : row[c])));
  const params = [salonId, row.yclients_txn_id, ...vals, source, deletedAt];
  const colList = TXN_COLS.join(', ');
  const placeholders = TXN_COLS.map((c, i) => `$${i + 3}${c === 'raw' ? '::jsonb' : ''}`).join(', ');
  const nSrc = TXN_COLS.length + 3;
  const nDel = TXN_COLS.length + 4;
  const sets = TXN_COLS.map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `
    INSERT INTO goods_transactions (salon_id, yclients_txn_id, ${colList}, source, deleted_at)
    VALUES ($1, $2, ${placeholders}, $${nSrc}, ${status === 'delete' ? `COALESCE($${nDel}::timestamptz, NOW())` : `$${nDel}::timestamptz`})
    ON CONFLICT (salon_id, yclients_txn_id) DO UPDATE SET
      ${sets}, source = EXCLUDED.source, updated_at = NOW(),
      deleted_at = ${status === 'delete' ? `COALESCE($${nDel}::timestamptz, NOW())` : 'NULL'}
  `;
  await db.query(sql, params);
  return { deleted: status === 'delete' };
}

/** Цена последнего поступления товара → yclients_goods_catalog.last_receipt_price/at. */
async function refreshLastReceipt(salonId, goodId) {
  const cat = await db.oneOrNone(
    'SELECT unit_equals FROM yclients_goods_catalog WHERE salon_id=$1 AND yclients_good_id=$2', [salonId, goodId]);
  const last = await db.oneOrNone(
    `SELECT create_date, amount, cost, operation_unit_type FROM goods_transactions
     WHERE salon_id=$1 AND good_id=$2 AND type_id=3 AND deleted_at IS NULL AND amount > 0
     ORDER BY create_date DESC, yclients_txn_id DESC LIMIT 1`, [salonId, goodId]);
  const price = last ? receiptUnitPrice(last, cat && cat.unit_equals) : null;
  const at = last ? last.create_date : null;
  await db.query(
    `UPDATE yclients_goods_catalog SET last_receipt_price=$3, last_receipt_at=$4, updated_at=NOW()
     WHERE salon_id=$1 AND yclients_good_id=$2`, [salonId, goodId, price, at]);
  return { price, at };
}

/** Для всех товаров салона с приходами (ночной проход после сверки). */
async function refreshAllLastReceipts(salonId) {
  const goods = await db.any(
    `SELECT DISTINCT good_id FROM goods_transactions WHERE salon_id=$1 AND type_id=3 AND deleted_at IS NULL AND good_id IS NOT NULL`, [salonId]);
  let n = 0;
  for (const g of goods) {
    try { await refreshLastReceipt(salonId, Number(g.good_id)); n++; }
    catch (e) { logger.warn(`refreshLastReceipt good=${g.good_id}: ${e.message}`); }
  }
  return n;
}

/** Апсерт экономических колонок товара; дерево категорий (category_*) не трогает. */
async function upsertCatalogGood(salonId, g) {
  await db.query(`
    INSERT INTO yclients_goods_catalog (salon_id, yclients_good_id, title, unit, service_unit, unit_equals,
      actual_cost, unit_actual_cost, stock, last_seen_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
    ON CONFLICT (salon_id, yclients_good_id) DO UPDATE SET
      title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE yclients_goods_catalog.title END,
      unit = EXCLUDED.unit, service_unit = EXCLUDED.service_unit, unit_equals = EXCLUDED.unit_equals,
      actual_cost = EXCLUDED.actual_cost, unit_actual_cost = EXCLUDED.unit_actual_cost, stock = EXCLUDED.stock,
      last_seen_at = NOW(), updated_at = NOW()
  `, [salonId, g.good_id, g.title || '', g.unit, g.service_unit, g.unit_equals, g.actual_cost, g.unit_actual_cost, JSON.stringify(g.stock || [])]);
}

// ── Техкарты и привязки ─────────────────────────────────────────────────────

/** Импорт карты YClients: UPSERT по (salon_id, yc_card_id). Возвращает id (или null). */
async function upsertTechCard(salonId, card) {
  const r = await db.oneOrNone(`
    INSERT INTO tech_cards (salon_id, yc_card_id, title, items, source, synced_at, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, 'yclients', NOW(), NOW())
    ON CONFLICT (salon_id, yc_card_id) WHERE yc_card_id IS NOT NULL DO UPDATE SET
      title = EXCLUDED.title, items = EXCLUDED.items, synced_at = NOW(), updated_at = NOW()
    RETURNING id`, [salonId, card.yc_card_id, card.title, JSON.stringify(card.items || [])]);
  return r ? r.id : null;
}

const LINK_SOURCES = new Set(['manual', 'lookup', 'learned']);
// Ранг источника в SQL — зеркало tech-cards.SOURCE_RANK (manual > lookup > learned).
const rankSql = (col) => `(CASE ${col} WHEN 'manual' THEN 0 WHEN 'lookup' THEN 1 ELSE 2 END)`;

/**
 * Привязка услуга(+сотрудник) → техкарта. Перезапись — только источником НЕ
 * МЛАДШЕ существующего: manual перетирает всё, lookup — lookup/learned,
 * learned — только learned. Иначе ночное обучение по факту затирало бы
 * найденную в YClients или выбранную владельцем карту.
 */
async function upsertServiceTechCard(salonId, { serviceYcId, staffYcId = null, techCardId, source }) {
  if (!LINK_SOURCES.has(source)) throw new Error(`upsertServiceTechCard: неизвестный source ${source}`);
  await db.query(`
    INSERT INTO service_tech_cards (salon_id, service_yc_id, staff_yc_id, tech_card_id, source, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (salon_id, service_yc_id, COALESCE(staff_yc_id, 0)) DO UPDATE SET
      tech_card_id = EXCLUDED.tech_card_id, source = EXCLUDED.source, updated_at = NOW()
    WHERE ${rankSql('service_tech_cards.source')} >= ${rankSql('EXCLUDED.source')}`,
  [salonId, serviceYcId, staffYcId, techCardId, source]);
}

/** Map String(yc_card_id) → tech_cards.id. */
async function listTechCardIdsByYc(salonId) {
  const rows = await db.any('SELECT id, yc_card_id FROM tech_cards WHERE salon_id=$1 AND yc_card_id IS NOT NULL', [salonId]);
  return new Map(rows.map(r => [String(r.yc_card_id), r.id]));
}

// Состоявшиеся записи дня со списаниями, у которых хоть одна пара (услуга, сотрудник)
// ещё не привязана ни к одной техкарте, — кандидаты на record_consumables.
const RECORDS_TO_LEARN_SQL = `
    SELECT r.yclients_record_id AS record_id, (r.staff->>'id')::bigint AS staff_yc_id
    FROM records r
    WHERE r.salon_id = $1 AND r.visit_date = $2::date AND r.raw_payload->>'attendance' = '1'
      AND COALESCE(r.status,'') <> 'deleted'
      AND EXISTS (SELECT 1 FROM goods_transactions t WHERE t.salon_id = r.salon_id AND t.record_id = r.yclients_record_id AND t.type_id = 2 AND t.deleted_at IS NULL)
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.services) = 'array' THEN r.services ELSE '[]'::jsonb END) s
        WHERE NOT EXISTS (SELECT 1 FROM service_tech_cards l WHERE l.salon_id = r.salon_id
          AND l.service_yc_id = (s->>'id')::bigint AND (l.staff_yc_id IS NULL OR l.staff_yc_id = (r.staff->>'id')::bigint)))
    ORDER BY r.yclients_record_id LIMIT $3`;

async function listRecordsToLearn(salonId, day, limit) {
  return db.any(RECORDS_TO_LEARN_SQL, [salonId, day, limit]);
}

// ── Загрузчики отчёта (задача 11) ────────────────────────────────────────────
// Форма выхода — ровно вход calc.buildRows/report.js: числа уже приведены
// (pg отдаёт bigint/numeric строками), даты — 'YYYY-MM-DD' по Москве.

const DEFAULT_SETTINGS = Object.freeze({
  payroll_multiplier: 1.3, pay_base_includes_bonuses: false, allocation_driver: 'minutes', usn_rate: 15, acquiring: Object.freeze({}),
});

// Состоявшиеся визиты периода: attendance=1, не удалены (у YClients удалённая
// запись может держать attendance=1 — отсюда обе проверки). Мастер — из staff,
// запасной путь raw_payload.staff_id. Списания бонусов по записи — LATERAL по
// частичному индексу idx_lct_salon_record. ГОТЧА: loyalty_card_transactions.record_id
// — это ВНУТРЕННИЙ records.id (его ставит loyalty.linkCardTransactionsToRecords),
// у части старых строк — yclients_record_id (так же сверяет дашборд, routes/api.js);
// сравнение только с yclients_record_id не находило на деве ни одного списания.
const RECORDS_SQL = `
  SELECT r.yclients_record_id AS record_id,
         to_char(r.visit_date, 'YYYY-MM-DD') AS visit_date,
         COALESCE(NULLIF(r.staff->>'id',''), NULLIF(r.raw_payload->>'staff_id',''))::bigint AS staff_yc_id,
         COALESCE(r.staff->>'name', r.specialist_name, '') AS staff_name,
         COALESCE(NULLIF(r.raw_payload->>'seance_length','')::int, 0) AS seance_length,
         COALESCE(r.services, '[]'::jsonb) AS services,
         COALESCE(b.bonus_redeemed, 0) AS bonus_redeemed
  FROM records r
  LEFT JOIN LATERAL (
    SELECT SUM(ABS(t.amount)) AS bonus_redeemed FROM loyalty_card_transactions t
    WHERE t.salon_id = r.salon_id AND t.record_id IN (r.id, r.yclients_record_id) AND t.type = 'redemption'
  ) b ON TRUE
  WHERE r.salon_id = $1 AND r.visit_date BETWEEN $2::date AND $3::date
    AND r.raw_payload->>'attendance' = '1'
    AND COALESCE(r.status, '') <> 'deleted'
    AND COALESCE(r.raw_payload->>'deleted', 'false') <> 'true'
  ORDER BY r.visit_date, r.yclients_record_id`;

const CONSUMABLES_SQL = `
  SELECT t.record_id, t.service_id, t.good_id, t.good_title, t.amount, t.cost, t.cost_per_unit, t.unit_title
  FROM goods_transactions t WHERE t.salon_id = $1 AND t.type_id = 2 AND t.deleted_at IS NULL
    AND t.record_id = ANY($2::bigint[])
  ORDER BY t.record_id, t.yclients_txn_id`;

const PAYMENTS_SQL = `
  SELECT yclients_record_id AS record_id, amount, account_title
  FROM revenue_operations WHERE salon_id = $1 AND category = 'services' AND yclients_record_id = ANY($2::bigint[])`;

// Приходы до конца дня $3 по Москве: create_date — timestamptz, граница считается
// явно, а не через TimeZone сессии пула.
const RECEIPTS_SQL = `
  SELECT good_id, create_date, amount, cost, operation_unit_type
  FROM goods_transactions WHERE salon_id = $1 AND type_id = 3 AND deleted_at IS NULL AND amount > 0
    AND good_id = ANY($2::bigint[])
    AND create_date < (($3::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow')
  ORDER BY good_id, create_date DESC`;

const CATALOG_SQL = `
  SELECT yclients_good_id AS good_id, title, unit, service_unit, unit_equals, actual_cost, unit_actual_cost, last_receipt_price, last_receipt_at
  FROM yclients_goods_catalog WHERE salon_id = $1 AND yclients_good_id = ANY($2::bigint[])`;

const OVERRIDES_SQL = `SELECT good_id, unit_price, note FROM goods_price_overrides WHERE salon_id = $1`;
const CARDS_SQL = `SELECT id, yc_card_id, title, items, source, synced_at, updated_at FROM tech_cards WHERE salon_id = $1`;
const LINKS_SQL = `SELECT service_yc_id, staff_yc_id, tech_card_id, source, updated_at FROM service_tech_cards WHERE salon_id = $1`;
const PAY_RULES_SQL = `
  SELECT id, staff_yc_id, service_yc_id, category_yc_id, percent, base, fixed_per_visit,
         to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to, note
  FROM staff_pay_rules WHERE salon_id = $1 ORDER BY id`;
const SETTINGS_SQL = `SELECT payroll_multiplier, pay_base_includes_bonuses, allocation_driver, usn_rate, acquiring FROM economics_settings WHERE salon_id = $1`;
const FIXED_SQL = `
  SELECT id, category, title, amount_month, to_char(month_from, 'YYYY-MM-DD') AS month_from, to_char(month_to, 'YYYY-MM-DD') AS month_to, note
  FROM fixed_costs WHERE salon_id = $1 ORDER BY month_from, id`;
const EQUIPMENT_SQL = `
  SELECT id, name, purchase_price, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, useful_life_months, residual_pct,
         maintenance_monthly, service_ids, is_active, note
  FROM equipment WHERE salon_id = $1 ORDER BY id`;
const CAPACITY_SQL = `SELECT COALESCE(SUM(work_minutes), 0) AS minutes FROM staff_schedule WHERE salon_id = $1 AND date BETWEEN $2::date AND $3::date`;

const N = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const toInt = N;

function normSettings(s) {
  if (!s) return { ...DEFAULT_SETTINGS, acquiring: {} };
  const usn = N(s.usn_rate);
  return {
    payroll_multiplier: N(s.payroll_multiplier) || DEFAULT_SETTINGS.payroll_multiplier,
    pay_base_includes_bonuses: !!s.pay_base_includes_bonuses,
    allocation_driver: s.allocation_driver === 'visits' ? 'visits' : 'minutes',
    usn_rate: Number.isFinite(usn) ? usn : DEFAULT_SETTINGS.usn_rate,
    acquiring: s.acquiring && typeof s.acquiring === 'object' && !Array.isArray(s.acquiring) ? { ...s.acquiring } : {},
  };
}

function pushTo(map, k, v) { if (!map.has(k)) map.set(k, []); map.get(k).push(v); }

/** Всё, что нужно отчёту за период, одним проходом. Типы приведены к числам. */
async function loadPeriod(salonId, from, to) {
  const recs = await db.any(RECORDS_SQL, [salonId, from, to]);
  const ids = recs.map(r => toInt(r.record_id));
  const [cons, pays] = ids.length
    ? await Promise.all([db.any(CONSUMABLES_SQL, [salonId, ids]), db.any(PAYMENTS_SQL, [salonId, ids])])
    : [[], []];
  const consBy = new Map(); const paysBy = new Map();
  for (const c of cons) pushTo(consBy, toInt(c.record_id), { good_id: toInt(c.good_id), service_id: toInt(c.service_id), amount: N(c.amount), cost: N(c.cost) });
  for (const p of pays) pushTo(paysBy, toInt(p.record_id), { amount: N(p.amount), account_title: p.account_title || '' });
  const records = recs.map(r => {
    const id = toInt(r.record_id);
    return {
      record_id: id, visit_date: r.visit_date, staff_yc_id: toInt(r.staff_yc_id), staff_name: r.staff_name || '',
      seance_length: Number(r.seance_length) || 0, services: Array.isArray(r.services) ? r.services : [],
      bonus_redeemed: N(r.bonus_redeemed) || 0, consumables: consBy.get(id) || [], payments: paysBy.get(id) || [],
    };
  });

  const [cardRows, linkRows, payRuleRows, settingsRow, fixedRows, eqRows, capRow, overrideRows] = await Promise.all([
    db.any(CARDS_SQL, [salonId]), db.any(LINKS_SQL, [salonId]), db.any(PAY_RULES_SQL, [salonId]),
    db.oneOrNone(SETTINGS_SQL, [salonId]), db.any(FIXED_SQL, [salonId]), db.any(EQUIPMENT_SQL, [salonId]),
    db.oneOrNone(CAPACITY_SQL, [salonId, from, to]), db.any(OVERRIDES_SQL, [salonId]),
  ]);
  const cards = new Map(cardRows.map(c => [Number(c.id), { ...c, id: Number(c.id), yc_card_id: toInt(c.yc_card_id), items: Array.isArray(c.items) ? c.items : [] }]));
  const links = linkRows.map(l => ({ ...l, service_yc_id: toInt(l.service_yc_id), staff_yc_id: toInt(l.staff_yc_id), tech_card_id: toInt(l.tech_card_id) }));

  const goodIds = new Set();
  for (const c of cons) if (c.good_id) goodIds.add(toInt(c.good_id));
  for (const card of cards.values()) for (const it of card.items) if (it && Number(it.good_id) > 0) goodIds.add(Number(it.good_id));
  const goodList = [...goodIds];
  const [receiptRows, catalogRows] = goodList.length
    ? await Promise.all([db.any(RECEIPTS_SQL, [salonId, goodList, to]), db.any(CATALOG_SQL, [salonId, goodList])])
    : [[], []];
  const receiptsByGood = new Map();
  for (const r of receiptRows) pushTo(receiptsByGood, toInt(r.good_id), { create_date: r.create_date, amount: N(r.amount), cost: N(r.cost), operation_unit_type: toInt(r.operation_unit_type) });
  const catalogByGood = new Map(catalogRows.map(c => [toInt(c.good_id), { ...c, good_id: toInt(c.good_id), unit_equals: N(c.unit_equals), unit_actual_cost: N(c.unit_actual_cost), actual_cost: N(c.actual_cost), last_receipt_price: N(c.last_receipt_price) }]));
  const overridesByGood = new Map(overrideRows.map(o => [toInt(o.good_id), { unit_price: N(o.unit_price), note: o.note }]));

  return {
    from, to, records, cards, links, receiptsByGood, catalogByGood, overridesByGood,
    payRules: payRuleRows.map(r => ({ ...r, staff_yc_id: toInt(r.staff_yc_id), service_yc_id: toInt(r.service_yc_id), category_yc_id: toInt(r.category_yc_id), percent: N(r.percent), fixed_per_visit: N(r.fixed_per_visit) })),
    settings: normSettings(settingsRow),
    fixedCosts: fixedRows.map(f => ({ ...f, amount_month: N(f.amount_month) })),
    equipment: eqRows.map(e => ({ ...e, purchase_price: N(e.purchase_price), residual_pct: N(e.residual_pct), maintenance_monthly: N(e.maintenance_monthly), service_ids: Array.isArray(e.service_ids) ? e.service_ids.map(Number) : [] })),
    capacityMinutes: capRow ? Number(capRow.minutes) || 0 : 0,
  };
}

module.exports = { upsertCatalogGood, upsertGoodsTransaction, refreshLastReceipt, refreshAllLastReceipts, TXN_COLS,
  upsertTechCard, upsertServiceTechCard, listTechCardIdsByYc, listRecordsToLearn, RECORDS_TO_LEARN_SQL,
  loadPeriod, normSettings, DEFAULT_SETTINGS, RECORDS_SQL, CONSUMABLES_SQL, PAYMENTS_SQL, RECEIPTS_SQL, CATALOG_SQL,
  OVERRIDES_SQL, CARDS_SQL, LINKS_SQL, PAY_RULES_SQL, SETTINGS_SQL, FIXED_SQL, EQUIPMENT_SQL, CAPACITY_SQL };
